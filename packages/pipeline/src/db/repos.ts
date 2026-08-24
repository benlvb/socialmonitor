import type { Db } from "@socialmonitor/db";
import {
  BREAKER_THRESHOLD,
  parseMonitorConfig,
  type MonitorConfig,
  type RawItem,
  type Source,
  type ThemeCandidate,
} from "@socialmonitor/shared";

export interface MonitorRow {
  id: string;
  owner_id: string;
  name: string;
  status: "active" | "paused";
  config: MonitorConfig;
}

export interface TargetRow {
  id: string;
  monitor_id: string;
  source: Source;
  kind: string;
  value: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface StreamState {
  cursor: string | null;
  cursor_meta: Record<string, unknown>;
  rows_total: number;
  consecutive_failures: number;
  breaker_tripped_at: Date | null;
  last_run_at: Date | null;
  last_success_at: Date | null;
}

export async function getMonitor(sql: Db, id: string): Promise<MonitorRow | null> {
  const rows = await sql`
    select id, owner_id, name, status, config from monitors where id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return { ...r, config: parseMonitorConfig(r.config) } as MonitorRow;
}

export async function getTargets(sql: Db, monitorId: string, source: Source): Promise<TargetRow[]> {
  return (await sql`
    select id, monitor_id, source, kind, value, enabled, config
    from targets where monitor_id = ${monitorId} and source = ${source} and enabled
    order by kind, value`) as unknown as TargetRow[];
}

export async function getStreamState(
  sql: Db,
  monitorId: string,
  source: string,
  stream: string,
): Promise<StreamState | null> {
  const rows = await sql`
    select cursor, cursor_meta, rows_total, consecutive_failures,
           breaker_tripped_at, last_run_at, last_success_at
    from sync_streams
    where monitor_id = ${monitorId} and source = ${source} and stream = ${stream}`;
  return (rows[0] as unknown as StreamState) ?? null;
}

/** Success: advance cursor (or hold if null), reset breaker counter. Full column list. */
export async function markStreamSuccess(
  sql: Db,
  monitorId: string,
  source: string,
  stream: string,
  cursor: string | null,
  rowsAdded: number,
  meta?: Record<string, unknown>,
): Promise<void> {
  const metaJson = meta === undefined ? null : JSON.stringify(meta);
  await sql`
    insert into sync_streams
      (monitor_id, source, stream, cursor, cursor_meta, rows_total,
       consecutive_failures, breaker_tripped_at, last_run_at, last_success_at, updated_at)
    values
      (${monitorId}, ${source}, ${stream}, ${cursor}, ${metaJson ?? "{}"}::jsonb, ${rowsAdded},
       0, null, now(), now(), now())
    on conflict (monitor_id, source, stream) do update set
      cursor = coalesce(${cursor}, sync_streams.cursor),
      cursor_meta = coalesce(${metaJson}::jsonb, sync_streams.cursor_meta),
      rows_total = sync_streams.rows_total + ${rowsAdded},
      consecutive_failures = 0,
      breaker_tripped_at = null,
      last_run_at = now(),
      last_success_at = now(),
      updated_at = now()`;
}

/**
 * Failure: cursor HELD (never advanced here — SPEC section 9).
 * Systemic failures increment the breaker counter; returns true when the breaker trips.
 */
export async function markStreamFailure(
  sql: Db,
  monitorId: string,
  source: string,
  stream: string,
  errorKind: "transient" | "systemic",
): Promise<boolean> {
  const inc = errorKind === "systemic" ? 1 : 0;
  const rows = await sql`
    insert into sync_streams
      (monitor_id, source, stream, consecutive_failures, last_run_at, updated_at)
    values (${monitorId}, ${source}, ${stream}, ${inc}, now(), now())
    on conflict (monitor_id, source, stream) do update set
      consecutive_failures = sync_streams.consecutive_failures + ${inc},
      breaker_tripped_at = case
        when sync_streams.consecutive_failures + ${inc} >= ${BREAKER_THRESHOLD}
          then coalesce(sync_streams.breaker_tripped_at, now())
        else sync_streams.breaker_tripped_at
      end,
      last_run_at = now(),
      updated_at = now()
    returning breaker_tripped_at, consecutive_failures`;
  const r = rows[0]!;
  return r.breaker_tripped_at != null && Number(r.consecutive_failures) >= BREAKER_THRESHOLD;
}

/** Store raw immediately; idempotent; FULL column list (omitted-column blanking rule). */
export async function insertRawItems(sql: Db, items: RawItem[]): Promise<number> {
  if (items.length === 0) return 0;
  // Clamp far-future posted_at (scheduled premieres, clock skew): such rows land
  // in raw_items_default and later make partition creation error (audit #5).
  const maxFuture = Date.now() + 48 * 3600 * 1000;
  for (const i of items) {
    if (i.postedAt.getTime() > maxFuture) {
      i.metrics = { ...i.metrics, original_posted_at: i.postedAt.toISOString() };
      i.postedAt = new Date();
    }
  }
  const rows = items.map((i) => ({
    monitor_id: i.monitorId,
    source: i.source,
    external_id: i.externalId,
    stream: i.stream,
    url: i.url,
    author_id: i.authorId,
    author_handle: i.authorHandle,
    author_name: i.authorName,
    author_followers: i.authorFollowers,
    content: i.content,
    posted_at: i.postedAt,
    parent_external_id: i.parentExternalId,
    context: sql.json(i.context as never),
    metrics: sql.json(i.metrics as never),
    impressions: i.impressions,
    engagement: i.engagement,
  }));
  await sql`
    insert into raw_items ${sql(rows)}
    on conflict (monitor_id, source, external_id, posted_at) do update set
      context = excluded.context,
      metrics = excluded.metrics,
      impressions = excluded.impressions,
      engagement = excluded.engagement`;
  return rows.length;
}

export interface UnclassifiedItem {
  external_id: string;
  stream: string;
  url: string;
  author_handle: string;
  author_name: string;
  author_followers: number | null;
  content: string;
  posted_at: Date;
  context: Record<string, unknown>;
}

/** Classify cursor = anti-join (SPEC section 3). Oldest first for stable ordering. */
export async function getUnclassifiedItems(
  sql: Db,
  monitorId: string,
  source: Source,
  limit: number,
): Promise<UnclassifiedItem[]> {
  return (await sql`
    select r.external_id, r.stream, r.url, r.author_handle, r.author_name,
           r.author_followers, r.content, r.posted_at, r.context
    from raw_items r
    left join item_classifications c
      on c.monitor_id = r.monitor_id and c.source = r.source and c.external_id = r.external_id
    where r.monitor_id = ${monitorId} and r.source = ${source} and c.external_id is null
    order by r.posted_at asc
    limit ${limit}`) as unknown as UnclassifiedItem[];
}

export interface ClassificationRow {
  monitorId: string;
  source: Source;
  externalId: string;
  relevant: boolean;
  signalType: string;
  sentiment: string;
  tags: string[];
  score: number | null;
  description: string;
  matchedExisting: boolean;
  reasoning: string;
  model: string;
  promptVersion: string;
}

export async function insertClassification(sql: Db, c: ClassificationRow): Promise<void> {
  await sql`
    insert into item_classifications
      (monitor_id, source, external_id, relevant, signal_type, sentiment, tags, score,
       description, matched_existing, reasoning, model, prompt_version, corrected, classified_at)
    values
      (${c.monitorId}, ${c.source}, ${c.externalId}, ${c.relevant}, ${c.signalType},
       ${c.sentiment}, ${c.tags}, ${c.score}, ${c.description}, ${c.matchedExisting},
       ${c.reasoning}, ${c.model}, ${c.promptVersion}, false, now())
    on conflict (monitor_id, source, external_id) do update set
      relevant = excluded.relevant,
      signal_type = excluded.signal_type,
      sentiment = excluded.sentiment,
      tags = excluded.tags,
      score = excluded.score,
      description = excluded.description,
      matched_existing = excluded.matched_existing,
      reasoning = excluded.reasoning,
      model = excluded.model,
      prompt_version = excluded.prompt_version,
      classified_at = now()`;
}

export async function getThemeCandidates(
  sql: Db,
  monitorId: string,
  source: Source,
): Promise<ThemeCandidate[]> {
  const rows = await sql`
    select signal_type, description, item_count, score_avg
    from themes
    where monitor_id = ${monitorId} and source = ${source}
    order by last_seen desc
    limit 500`;
  return rows.map((r) => ({
    signal_type: r.signal_type as string,
    description: r.description as string,
    item_count: Number(r.item_count),
    score_avg: r.score_avg == null ? null : Number(r.score_avg),
  }));
}

export interface ThemeMergeInput {
  monitorId: string;
  source: Source;
  signalType: string;
  description: string;
  tags: string[];
  score: number | null;
  author: string;
  itemRef: { externalId: string; url: string; author: string; postedAt: string };
}

const MAX_ITEM_REFS = 50;

/**
 * Merge one classified item into its theme row inside a transaction.
 * author_count = DISTINCT authors (the ranking metric, D-Discord rule).
 */
export async function mergeTheme(sql: Db, m: ThemeMergeInput): Promise<void> {
  await sql.begin(async (tx) => {
    const existing = await tx`
      select tags, score_avg, item_count, author_count, authors, item_refs, first_seen
      from themes
      where monitor_id = ${m.monitorId} and source = ${m.source}
        and signal_type = ${m.signalType} and description = ${m.description}
      for update`;
    const today = new Date().toISOString().slice(0, 10);
    if (existing.length === 0) {
      await tx`
        insert into themes
          (monitor_id, source, signal_type, description, tags, score_avg, item_count,
           author_count, authors, item_refs, first_seen, last_seen, updated_at)
        values
          (${m.monitorId}, ${m.source}, ${m.signalType}, ${m.description},
           ${m.tags.slice(0, 3)}, ${m.score}, 1, 1, ${[m.author]},
           ${tx.json([m.itemRef] as never)}, ${today}, ${today}, now())`;
      return;
    }
    const e = existing[0]!;
    const oldCount = Number(e.item_count);
    const newCount = oldCount + 1;
    const oldAvg = e.score_avg == null ? null : Number(e.score_avg);
    const newAvg =
      m.score == null
        ? oldAvg
        : oldAvg == null
          ? m.score
          : Math.round(((oldAvg * oldCount + m.score) / newCount) * 100) / 100;
    const mergedTags = [...new Set([...(e.tags as string[]), ...m.tags])].slice(0, 3);
    const authors = [...new Set([...(e.authors as string[]), m.author].filter(Boolean))];
    const refs = [...(e.item_refs as unknown[]), m.itemRef].slice(-MAX_ITEM_REFS);
    await tx`
      update themes set
        tags = ${mergedTags},
        score_avg = ${newAvg},
        item_count = ${newCount},
        author_count = ${authors.length},
        authors = ${authors},
        item_refs = ${tx.json(refs as never)},
        last_seen = ${today},
        updated_at = now()
      where monitor_id = ${m.monitorId} and source = ${m.source}
        and signal_type = ${m.signalType} and description = ${m.description}`;
  });
}

export async function recordUsage(
  sql: Db,
  monitorId: string,
  calls: number,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): Promise<void> {
  await sql`
    insert into llm_usage (monitor_id, day, calls, input_tokens, output_tokens, cost_usd)
    values (${monitorId}, current_date, ${calls}, ${inputTokens}, ${outputTokens}, ${costUsd})
    on conflict (monitor_id, day) do update set
      calls = llm_usage.calls + ${calls},
      input_tokens = llm_usage.input_tokens + ${inputTokens},
      output_tokens = llm_usage.output_tokens + ${outputTokens},
      cost_usd = llm_usage.cost_usd + ${costUsd}`;
}

export async function getTodayCalls(sql: Db, monitorId: string): Promise<number> {
  const rows = await sql`
    select calls from llm_usage where monitor_id = ${monitorId} and day = current_date`;
  return rows.length ? Number(rows[0]!.calls) : 0;
}

export async function getMonthCostUsd(sql: Db): Promise<number> {
  const rows = await sql`
    select coalesce(sum(cost_usd), 0) as total
    from llm_usage where day >= date_trunc('month', current_date)`;
  return Number(rows[0]!.total);
}

export interface VerdictExample {
  item_text: string;
  corrected: Record<string, unknown>;
  note: string;
}

export async function getRecentVerdicts(
  sql: Db,
  monitorId: string,
  limit: number,
): Promise<VerdictExample[]> {
  return (await sql`
    select item_text, corrected, note
    from review_verdicts
    where monitor_id = ${monitorId}
    order by created_at desc
    limit ${limit}`) as unknown as VerdictExample[];
}

/** Persist per-stream metadata (e.g. pending Anthropic batch id) without touching the cursor. */
export async function updateStreamMeta(
  sql: Db,
  monitorId: string,
  source: string,
  stream: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await sql`
    insert into sync_streams (monitor_id, source, stream, cursor_meta, last_run_at, updated_at)
    values (${monitorId}, ${source}, ${stream}, ${sql.json(meta as never)}, now(), now())
    on conflict (monitor_id, source, stream) do update set
      cursor_meta = ${sql.json(meta as never)},
      last_run_at = now(),
      updated_at = now()`;
}

/** Debounce helper: has an event of this kind fired today for this monitor? */
export async function hasEventToday(
  sql: Db,
  monitorId: string | null,
  kind: string,
): Promise<boolean> {
  const rows = await sql`
    select 1 from pipeline_events
    where kind = ${kind}
      and (monitor_id = ${monitorId} or (${monitorId}::uuid is null and monitor_id is null))
      and created_at >= date_trunc('day', now())
    limit 1`;
  return rows.length > 0;
}

export interface DueMetricsRef {
  external_id: string;
  url: string;
  author_handle: string;
  posted_at: Date;
}

/**
 * Items due a metrics checkpoint (D15): relevant items whose age crossed the
 * checkpoint and that have no metrics_history row for it yet.
 */
export async function getDueMetricsRefs(
  sql: Db,
  monitorId: string,
  source: Source,
  checkpoint: "1h" | "24h" | "7d",
  limit = 100,
): Promise<DueMetricsRef[]> {
  const age =
    checkpoint === "1h" ? "1 hour" : checkpoint === "24h" ? "24 hours" : "7 days";
  return (await sql`
    select r.external_id, r.url, r.author_handle, r.posted_at
    from raw_items r
    join item_classifications c
      on c.monitor_id = r.monitor_id and c.source = r.source and c.external_id = r.external_id
    where r.monitor_id = ${monitorId} and r.source = ${source}
      and c.relevant
      and r.posted_at <= now() - ${age}::interval
      and r.posted_at > now() - interval '8 days'
      and not exists (
        select 1 from metrics_history m
        where m.monitor_id = r.monitor_id and m.source = r.source
          and m.external_id = r.external_id and m.checkpoint = ${checkpoint}
      )
    order by r.posted_at asc
    limit ${limit}`) as unknown as DueMetricsRef[];
}

export async function insertMetricsHistory(
  sql: Db,
  monitorId: string,
  source: Source,
  externalId: string,
  checkpoint: string,
  metrics: Record<string, unknown>,
  impressions: number | null,
  engagement: number | null,
): Promise<void> {
  await sql`
    insert into metrics_history
      (monitor_id, source, external_id, checkpoint, metrics, impressions, engagement, captured_at)
    values (${monitorId}, ${source}, ${externalId}, ${checkpoint},
            ${sql.json(metrics as never)}, ${impressions}, ${engagement}, now())
    on conflict (monitor_id, source, external_id, checkpoint) do update set
      metrics = excluded.metrics,
      impressions = excluded.impressions,
      engagement = excluded.engagement,
      captured_at = now()`;
}
