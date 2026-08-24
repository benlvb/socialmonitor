import type { Source } from "./constants";

/** Normalized item every adapter must produce (SPEC section 3, raw_items). */
export interface RawItem {
  monitorId: string;
  source: Source;
  externalId: string;
  stream: string;
  url: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorFollowers: number | null;
  content: string;
  postedAt: Date;
  parentExternalId: string;
  /** reply chain, parent post, linear neighbors, channel name — adapter-defined */
  context: Record<string, unknown>;
  /** full platform metrics as returned */
  metrics: Record<string, unknown>;
  impressions: number | null; // null where the platform has no view metric
  engagement: number | null;
}

export interface ItemRef {
  externalId: string;
  url: string;
  author: string;
  postedAt: string; // ISO
}

export interface MetricsRow {
  externalId: string;
  metrics: Record<string, unknown>;
  impressions: number | null;
  engagement: number | null;
}

/**
 * Cap a platform timestamp at "now" (audit #9). A future-dated item (scheduled
 * premieres, clock skew) otherwise pushes a time-based cursor into the future,
 * where every later run filters everything out and reports success — a stream
 * dead until that date, invisible in the health panel. Clamping at PARSE time
 * keeps the stored row and the computed cursor consistent.
 */
export function clampFutureDate(d: Date, toleranceMs = 5 * 60 * 1000): Date {
  const now = Date.now();
  return d.getTime() > now + toleranceMs ? new Date(now) : d;
}
