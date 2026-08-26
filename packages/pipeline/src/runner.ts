import type { Db } from "@socialmonitor/db";
import {
  METRIC_CHECKPOINTS,
  PerItemError,
  SystemicError,
  TransientError,
  type JobPayload,
  type Source,
} from "@socialmonitor/shared";
import { getAdapter } from "./adapters/registry";
import type { SourceAdapter, StreamDef } from "./adapters/types";
import { runClassify } from "./classify/engine";
import {
  getDueMetricsRefs,
  getMonitor,
  getStreamState,
  getTargets,
  insertMetricsHistory,
  insertRawItems,
  markStreamFailure,
  markStreamSuccess,
  type MonitorRow,
} from "./db/repos";
import { logEvent } from "./events";
import { withStreamLock } from "./queue";
import { runWeeklySummary } from "./summary";

/** Entry point for one queued job — expands (monitor, source, kind) to streams. */
export async function runJob(sql: Db, job: JobPayload): Promise<void> {
  const monitor = await getMonitor(sql, job.monitorId);
  if (!monitor || monitor.status !== "active") return;

  if (job.kind === "weekly_summary") {
    // Own error boundary: a summary failure must alert (summary_failed) and
    // must NOT inherit fetch retry semantics — post-model-call retries re-bill.
    try {
      await withStreamLock(sql, `${monitor.id}:_system`, "weekly_summary", () =>
        runWeeklySummary(sql, monitor),
      );
    } catch (err) {
      await logEvent(sql, {
        monitorId: monitor.id,
        level: "error",
        kind: "summary_failed",
        message: `weekly summary failed: ${String(err)}`,
      });
      // Clear the dispatch marker so the producer can re-dispatch instead of
      // waiting a week (the message itself is consumed either way — audit #18).
      await sql`
        delete from sync_streams
        where monitor_id = ${monitor.id} and source = '_system'
          and stream = 'dispatch/weekly_summary'`;
    }
    return;
  }

  const source = job.source as Source;
  const adapter = getAdapter(source);
  const status = await adapter.status(sql, monitor.owner_id);
  if (!status.configured) {
    // Template-first (D22): unconfigured is a valid state — skip silently.
    return;
  }

  if (job.kind === "fetch") {
    const targets = await getTargets(sql, monitor.id, source);
    for (const stream of adapter.streams(monitor, targets)) {
      await withStreamLock(sql, `${monitor.id}:${source}`, stream.stream, () =>
        runFetchStream(sql, monitor, adapter, stream),
      );
    }
    return;
  }

  if (job.kind === "classify") {
    await withStreamLock(sql, `${monitor.id}:${source}`, "classify", () =>
      runClassify(sql, monitor, source),
    );
    return;
  }

  if (job.kind === "metrics") {
    // Own error boundary (audit #18): a metrics failure must not poison the
    // queue message; it logs, holds, and retries on the next cadence tick.
    try {
      await withStreamLock(sql, `${monitor.id}:${source}`, "metrics_refresh", () =>
        runMetricsRefresh(sql, monitor, adapter, source),
      );
    } catch (err) {
      await markStreamFailure(sql, monitor.id, source, "metrics_refresh", "transient");
      await logEvent(sql, {
        monitorId: monitor.id,
        source,
        stream: "metrics_refresh",
        level: "warn",
        kind: "run_failed",
        message: `metrics refresh failed: ${String(err).slice(0, 300)}`,
      });
    }
  }
}

/**
 * The cursor contract (SPEC sections 2 and 9):
 * - store raw immediately;
 * - advance the cursor only on a fully successful run;
 * - TransientError holds the cursor; SystemicError increments the breaker;
 * - a tripped breaker skips the stream and alerts once.
 */
export async function runFetchStream(
  sql: Db,
  monitor: MonitorRow,
  adapter: SourceAdapter,
  stream: StreamDef,
): Promise<void> {
  const state = await getStreamState(sql, monitor.id, adapter.source, stream.stream);
  if (state?.breaker_tripped_at) return; // operator resets via UI

  try {
    const result = await adapter.fetch({
      sql,
      monitor,
      stream,
      cursor: state?.cursor ?? null,
      cursorMeta: (state?.cursor_meta as Record<string, unknown>) ?? {},
    });
    const stored = await insertRawItems(sql, result.items);
    await markStreamSuccess(
      sql,
      monitor.id,
      adapter.source,
      stream.stream,
      result.nextCursor,
      stored,
      result.cursorMeta,
    );
    if (result.droppedCount) {
      await logEvent(sql, {
        monitorId: monitor.id,
        source: adapter.source,
        stream: stream.stream,
        level: "warn",
        kind: "items_dropped",
        message: `${result.droppedCount} unparseable item(s) dropped (per-item errors)`,
      });
    }
  } catch (err) {
    if (err instanceof PerItemError) {
      // Adapters normally handle these internally; treat a thrown one as a full-
      // batch drop with the cursor held so nothing is skipped silently.
      await markStreamFailure(sql, monitor.id, adapter.source, stream.stream, "transient");
      await logEvent(sql, {
        monitorId: monitor.id,
        source: adapter.source,
        stream: stream.stream,
        level: "warn",
        kind: "run_failed",
        message: `per-item error escaped adapter: ${err.message}`,
      });
      return;
    }
    if (err instanceof TransientError) {
      await markStreamFailure(sql, monitor.id, adapter.source, stream.stream, "transient");
      await logEvent(sql, {
        monitorId: monitor.id,
        source: adapter.source,
        stream: stream.stream,
        level: "warn",
        kind: "run_failed",
        message: `transient: ${err.message} (cursor held, retry next run)`,
      });
      return;
    }
    const message = err instanceof SystemicError ? err.message : String(err);
    const tripped = await markStreamFailure(
      sql,
      monitor.id,
      adapter.source,
      stream.stream,
      "systemic",
    );
    await logEvent(sql, {
      monitorId: monitor.id,
      source: adapter.source,
      stream: stream.stream,
      level: tripped ? "error" : "warn",
      kind: tripped ? "breaker_tripped" : "run_failed",
      message: tripped
        ? `breaker tripped after repeated systemic failures: ${message}`
        : `systemic: ${message}`,
    });
  }
}

async function runMetricsRefresh(
  sql: Db,
  monitor: MonitorRow,
  adapter: SourceAdapter,
  source: Source,
): Promise<void> {
  if (!adapter.refreshMetrics) return;
  const checkpoints = monitor.config.limits.metrics_checkpoints;
  for (const checkpoint of METRIC_CHECKPOINTS) {
    if (!checkpoints.includes(checkpoint)) continue;
    const due = await getDueMetricsRefs(sql, monitor.id, source, checkpoint, 100, adapter.metricsRefPrefix);
    if (due.length === 0) continue;
    const rows = await adapter.refreshMetrics(
      sql,
      monitor,
      due.map((d) => ({
        externalId: d.external_id,
        url: d.url,
        author: d.author_handle,
        postedAt: d.posted_at.toISOString(),
      })),
    );
    for (const row of rows) {
      await insertMetricsHistory(
        sql,
        monitor.id,
        source,
        row.externalId,
        checkpoint,
        row.metrics,
        row.impressions,
        row.engagement,
      );
    }
  }
}
