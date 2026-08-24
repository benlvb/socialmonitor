import type { Source } from "./constants.js";

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
