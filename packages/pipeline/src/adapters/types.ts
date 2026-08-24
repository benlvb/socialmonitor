import type { Db } from "@socialmonitor/db";
import type { ItemRef, MetricsRow, RawItem, Source } from "@socialmonitor/shared";
import type { MonitorRow, TargetRow } from "../db/repos.js";

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
}

export interface FetchResult {
  items: RawItem[];
  /** null = hold current cursor (nothing newer). */
  nextCursor: string | null;
  /** per-item parse failures dropped inside the adapter (logged, cursor may advance) */
  droppedCount?: number;
}

/**
 * Contract every source implements (SPEC section 5).
 * Template-first (D22): status() must never throw on missing credentials —
 * it reports { configured: false } and the runner skips cleanly.
 */
export interface SourceAdapter {
  readonly source: Source;
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
