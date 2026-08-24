import type { Db } from "@socialmonitor/db";
import type { ItemRef, MetricsRow, RawItem, Source } from "@socialmonitor/shared";
import type { MonitorRow, TargetRow } from "../db/repos";

export interface AdapterStatus {
  configured: boolean;
  detail?: string;
}

export interface StreamDef {
  /** e.g. "search/<targetId>", "account/<targetId>", "channel/<id>" */
  stream: string;
  target?: TargetRow;
}

export interface FetchContext {
  sql: Db;
  monitor: MonitorRow;
  stream: StreamDef;
  cursor: string | null;
  /** Persisted per-stream metadata (e.g. per-channel cursor maps). */
  cursorMeta: Record<string, unknown>;
}

export interface FetchResult {
  items: RawItem[];
  /** null = hold current cursor (nothing newer). */
  nextCursor: string | null;
  /** per-item parse failures dropped inside the adapter (logged, cursor may advance) */
  droppedCount?: number;
  /** When set, replaces the stream's cursor_meta on success (per-channel cursors etc.). */
  cursorMeta?: Record<string, unknown>;
}

/**
 * Contract every source implements (SPEC section 5).
 * Template-first (D22): status() must never throw on missing credentials —
 * it reports { configured: false } and the runner skips cleanly.
 */
export interface SourceAdapter {
  readonly source: Source;
  /** Only external_ids with this prefix are due for metrics refresh (audit #18). */
  readonly metricsRefPrefix?: string;
  status(sql: Db, ownerId: string): Promise<AdapterStatus>;
  testConnection(sql: Db, ownerId: string): Promise<{ ok: boolean; message: string }>;
  streams(monitor: MonitorRow, targets: TargetRow[]): StreamDef[];
  fetch(ctx: FetchContext): Promise<FetchResult>;
  refreshMetrics?(
    sql: Db,
    monitor: MonitorRow,
    refs: ItemRef[],
  ): Promise<MetricsRow[]>;
}
