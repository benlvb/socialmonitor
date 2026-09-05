"use server";

import { revalidatePath } from "next/cache";
import { createDb, type Db } from "@socialmonitor/db";
import { parseMonitorConfig, SOURCES, type Source } from "@socialmonitor/shared";
import { getAdapter } from "@socialmonitor/pipeline/adapters";
import type { MonitorRow, TargetRow } from "@socialmonitor/pipeline/repos";
import { requireUser } from "../../../../lib/supabase/server";

/**
 * Tier-1 pipeline controls. Every action verifies ownership under RLS first,
 * then uses the service path (postgres) for queue/stream writes — the same
 * pattern as corrections.
 */

async function ownedMonitor(monitorId: string): Promise<{
  monitor: { id: string; owner_id: string; name: string; status: string; config: unknown } | null;
  targets: { source: string; kind: string; value: string; enabled: boolean; id: string; monitor_id: string; config: unknown }[];
}> {
  const { supabase, user } = await requireUser();
  if (!user) return { monitor: null, targets: [] };
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, owner_id, name, status, config")
    .eq("id", monitorId)
    .single();
  if (!monitor) return { monitor: null, targets: [] };
  const { data: targets } = await supabase
    .from("targets")
    .select("id, monitor_id, source, kind, value, enabled, config")
    .eq("monitor_id", monitorId)
    .eq("enabled", true);
  return { monitor, targets: targets ?? [] };
}

async function enqueue(sql: Db, monitorId: string, source: string, kind: string): Promise<void> {
  await sql`select pgmq.send('pipeline_jobs',
    ${sql.json({ monitorId, source, kind } as never)})`;
}

async function logInfo(sql: Db, monitorId: string, kind: string, message: string): Promise<void> {
  await sql`
    insert into pipeline_events (monitor_id, source, stream, level, kind, message, meta)
    values (${monitorId}, null, null, 'info', ${kind}, ${message}, ${"{}"})`;
}

/** Enqueue fetch+classify+metrics for every source with enabled targets — right now. */
export async function runNow(monitorId: string): Promise<void> {
  const { monitor, targets } = await ownedMonitor(monitorId);
  if (!monitor) return;
  const sql = createDb();
  if (!sql) return;
  try {
    const sources = [...new Set(targets.map((t) => t.source))];
    for (const source of sources) {
      for (const kind of ["fetch", "classify", "metrics"]) {
        await enqueue(sql, monitorId, source, kind);
      }
    }
    await logInfo(sql, monitorId, "run_now", `manual run: ${sources.join(", ") || "no sources"}`);
  } finally {
    await sql.end({ timeout: 3 });
  }
  revalidatePath(`/monitors/${monitorId}`);
}

/** Clear a tripped breaker and immediately retry that source's fetch. */
export async function resetBreaker(
  monitorId: string,
  source: string,
  stream: string,
): Promise<void> {
  const { monitor } = await ownedMonitor(monitorId);
  if (!monitor) return;
  const sql = createDb();
  if (!sql) return;
  try {
    await sql`
      update sync_streams
      set breaker_tripped_at = null, consecutive_failures = 0, updated_at = now()
      where monitor_id = ${monitorId} and source = ${source} and stream = ${stream}`;
    await enqueue(sql, monitorId, source, "fetch");
    await logInfo(sql, monitorId, "breaker_reset", `breaker reset on ${source}/${stream}`);
  } finally {
    await sql.end({ timeout: 3 });
  }
  revalidatePath(`/monitors/${monitorId}`);
}

const DISCORD_EPOCH = 1420070400000n;
const dateToSnowflake = (d: Date): string =>
  ((BigInt(d.getTime()) - DISCORD_EPOCH) << 22n).toString();

/** Rough messages-per-day assumption used to bound a Telegram rewind. */
const TELEGRAM_MSGS_PER_DAY = 50;
const TELEGRAM_MAX_REWIND = 1000;

/**
 * Backfill cursor per source. Each platform's cursor has different semantics,
 * and they diverged from this action when the adapters were reworked
 * (audit #5) — this is the single place that knows the mapping.
 * Returns null when the source cannot be rewound by a date window.
 */
function backfillCursor(source: Source, days: number): string | null {
  const since = new Date(Date.now() - days * 864e5);
  switch (source) {
    case "x":
    case "reddit":
      return String(Math.floor(since.getTime() / 1000)); // epoch seconds
    case "youtube":
      return since.toISOString(); // publishedAfter
    case "appstore":
      return since.toISOString(); // newest-first walk back to this `updated`
    case "discord":
      return dateToSnowflake(since);
    case "telegram":
      // Message-id cursors cannot encode a date, and minId=0 means "from the
      // beginning of the channel" — which would crawl years of history through
      // the classifier. Handled separately as a bounded rewind from the
      // CURRENT cursor; never from zero.
      return null;
  }
}

export async function backfill(monitorId: string, formData: FormData): Promise<void> {
  const days = Math.max(1, Math.min(30, Number(formData.get("days") ?? 7)));
  const { monitor, targets } = await ownedMonitor(monitorId);
  if (!monitor) return;
  const sql = createDb();
  if (!sql) return;
  try {
    const monitorRow: MonitorRow = {
      id: monitor.id,
      owner_id: monitor.owner_id,
      name: monitor.name,
      status: monitor.status as "active" | "paused",
      config: parseMonitorConfig(monitor.config),
    };
    const sources = [...new Set(targets.map((t) => t.source))] as Source[];
    const notes: string[] = [];

    for (const source of sources) {
      if (!SOURCES.includes(source)) continue;
      const adapter = getAdapter(source);
      const streams = adapter.streams(
        monitorRow,
        targets.filter((t) => t.source === source) as unknown as TargetRow[],
      );
      const cursor = backfillCursor(source, days);

      for (const s of streams) {
        // Comment streams derive from stored parents and carry no cursor.
        if (s.stream === "comments") continue;

        const existing = await sql`
          select cursor, cursor_meta from sync_streams
          where monitor_id = ${monitorId} and source = ${source} and stream = ${s.stream}`;
        const prevCursor = existing[0]?.cursor as string | null | undefined;
        const prevMeta = (existing[0]?.cursor_meta ?? {}) as Record<string, unknown>;

        if (source === "discord") {
          // Discord consults cursor_meta.channels FIRST — rewinding the scalar
          // cursor alone was a silent no-op (audit #5).
          const snowflake = cursor!;
          const channels = { ...((prevMeta.channels as Record<string, string>) ?? {}) };
          for (const id of Object.keys(channels)) channels[id] = snowflake;
          const meta = JSON.stringify({ ...prevMeta, channels, canary_strikes: 0 });
          await sql`
            insert into sync_streams
              (monitor_id, source, stream, cursor, cursor_meta, rows_total,
               consecutive_failures, breaker_tripped_at, last_run_at, last_success_at, updated_at)
            values (${monitorId}, ${source}, ${s.stream}, ${snowflake}, ${meta}::jsonb, 0,
                    0, null, null, null, now())
            on conflict (monitor_id, source, stream) do update set
              cursor = ${snowflake},
              cursor_meta = ${meta}::jsonb,
              consecutive_failures = 0,
              breaker_tripped_at = null,
              updated_at = now()`;
          notes.push(
            `discord: ${Object.keys(channels).length} known channel(s) rewound${
              Object.keys(channels).length === 0 ? " (none synced yet — nothing to rewind)" : ""
            }`,
          );
          continue;
        }

        if (source === "telegram") {
          // Bounded rewind from the current position; NEVER 0 (that means
          // "from the channel's first message" and crawls all history).
          if (!prevCursor || Number(prevCursor) <= 1) {
            notes.push("telegram: skipped (no synced position yet to rewind from)");
            continue;
          }
          const back = Math.min(days * TELEGRAM_MSGS_PER_DAY, TELEGRAM_MAX_REWIND);
          const rewound = String(Math.max(1, Number(prevCursor) - back));
          await sql`
            update sync_streams
            set cursor = ${rewound}, consecutive_failures = 0,
                breaker_tripped_at = null, updated_at = now()
            where monitor_id = ${monitorId} and source = ${source} and stream = ${s.stream}`;
          notes.push(`telegram: rewound ~${back} messages`);
          continue;
        }

        const meta = JSON.stringify({ ...prevMeta, pending_until: null, pending_newest: null });
        await sql`
          insert into sync_streams
            (monitor_id, source, stream, cursor, cursor_meta, rows_total,
             consecutive_failures, breaker_tripped_at, last_run_at, last_success_at, updated_at)
          values (${monitorId}, ${source}, ${s.stream}, ${cursor}, ${meta}::jsonb, 0,
                  0, null, null, null, now())
          on conflict (monitor_id, source, stream) do update set
            cursor = ${cursor},
            cursor_meta = ${meta}::jsonb,
            consecutive_failures = 0,
            breaker_tripped_at = null,
            updated_at = now()`;
      }

      await enqueue(sql, monitorId, source, "fetch");
      await enqueue(sql, monitorId, source, "classify");
    }

    await logInfo(
      sql,
      monitorId,
      "backfill_started",
      `backfill last ${days}d on ${sources.join(", ") || "no sources"}` +
        (notes.length ? ` — ${notes.join("; ")}` : ""),
    );
  } finally {
    await sql.end({ timeout: 3 });
  }
  revalidatePath(`/monitors/${monitorId}`);
}
