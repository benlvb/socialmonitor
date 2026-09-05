import {
  SystemicError,
  TransientError,
  clampFutureDate,
  errorFromStatus,
  type RawItem,
} from "@socialmonitor/shared";
import { hasEventToday, type MonitorRow, type TargetRow } from "../db/repos";
import { logEvent } from "../events";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { fixtureMode, loadFixture } from "./fixtures";

/**
 * Apple App Store reviews (D23) over Apple's public customer-reviews feed —
 * no credentials, any app (yours or a competitor's).
 *
 * Feed facts (probed 2026-09-05 against a large app, US/GB storefronts):
 * `/<cc>/rss/customerreviews/id=<app>/sortBy=mostRecent/page=<n>/json` returns
 * 50 entries per page, newest-first by `updated`, hard-capped at page 10 (page
 * 11 answers 400) — i.e. the newest 500 reviews per storefront. Some storefronts
 * return an empty feed. Review ids are numeric and increase with time. `updated`
 * is second-granular and is the review's creation time until the author edits.
 *
 * Streams: one per (target, storefront) named `reviews/<cc>/<target uuid>`; the
 * uuid suffix keeps the target-deletion cleanup (`stream like '%/<id>'`) working.
 *
 * Termination: a healthy page carries `link[rel=last]`; a genuinely exhausted
 * page past the end still carries it (`last` < page), while Apple's occasional
 * TRANSIENT empty page mid-feed (probed: 4 of 30 app×storefront pairs, gone on
 * retry) carries no links at all, and a storefront Apple does not serve returns
 * links whose hrefs are empty strings (no page number). So: a page at or past
 * `last` ends the walk; an empty or short page BELOW `last`, or with no usable
 * `last` at all, is an anomaly —
 * the items already parsed are stored, the cursor HOLDS, and a `coverage_gap`
 * warning is logged, because advancing would skip the missing page for good.
 *
 * Cursor: ISO `updated` of the newest review seen. Walk newest-first until an
 * entry STRICTLY older than the cursor appears (window covered), the feed ends
 * per the links, or Apple's page cap. The cap also counts as covered:
 * nothing older is obtainable, so the cursor ADVANCES and a `coverage_lost`
 * error records what was skipped — holding there would re-walk 10 pages every
 * tick forever. Apple's cap bounds the walk to 500 reviews, so the shared
 * `limits.max_pages_per_fetch` knob (built for metered APIs) does not apply; a
 * smaller cap could never converge on a busy app's backfill.
 *
 * Edited reviews resurface with a new `updated` but the same id. The PK on
 * raw_items includes posted_at, so a second row would double the item count
 * that ranks the dedup shortlist; ids already stored on this stream are
 * dropped and the first-seen text is kept.
 */

const RSS_HOST = "https://itunes.apple.com";
const PAGE_SIZE = 50;
/** Apple serves at most this many pages per storefront. */
export const APPSTORE_FEED_PAGE_CAP = 10;

interface RssLabel {
  label?: string;
}
export interface RssEntry {
  id?: RssLabel;
  title?: RssLabel;
  content?: RssLabel;
  updated?: RssLabel;
  author?: { name?: RssLabel; uri?: RssLabel };
  "im:rating"?: RssLabel;
  "im:version"?: RssLabel;
  "im:voteSum"?: RssLabel;
  "im:voteCount"?: RssLabel;
}
interface RssLink {
  attributes?: { rel?: string; href?: string };
}
interface RssFeed {
  feed?: { entry?: RssEntry | RssEntry[]; link?: RssLink | RssLink[] };
}

/** Page number from `link[rel=last]`, or null when the feed carries no links. */
export function lastPageOf(feed: RssFeed): number | null {
  const raw = feed.feed?.link;
  if (!raw) return null;
  const links = Array.isArray(raw) ? raw : [raw];
  const last = links.find((l) => l?.attributes?.rel === "last");
  // The live href carries `page=` twice (`/page=10/` in the path, `...page=2/json`
  // in the query) — anchor on the path segment.
  const m = last?.attributes?.href?.match(/\/page=(\d+)\//);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Accepts a bare numeric id or an App Store URL containing `/id<digits>`. */
export function parseAppId(value: string): string | null {
  const v = (value ?? "").trim();
  if (/^\d{3,}$/.test(v)) return v;
  const m = v.match(/\/id(\d{3,})(?:[/?#]|$)/);
  return m?.[1] ?? null;
}

export function feedUrl(cc: string, appId: string, page: number): string {
  return `${RSS_HOST}/${cc}/rss/customerreviews/id=${appId}/sortBy=mostRecent/page=${page}/json`;
}

function entriesOf(feed: RssFeed): RssEntry[] {
  const e = feed.feed?.entry;
  if (!e) return [];
  return Array.isArray(e) ? e : [e];
}

export function parseReview(
  monitorId: string,
  stream: string,
  cc: string,
  appId: string,
  e: RssEntry,
): RawItem | null {
  const id = e.id?.label?.trim();
  const updated = e.updated?.label;
  if (!id || !updated) return null;
  const postedAt = new Date(updated);
  if (Number.isNaN(postedAt.getTime())) return null;
  const title = (e.title?.label ?? "").trim();
  const body = (e.content?.label ?? "").trim();
  // ~5% of live reviews repeat the title as (or inside) the body — "👎"/"👎",
  // "BEST"/"BEST APP"; joining them doubles text and defeats
  // prefilter.min_chars (review F5). Keep whichever contains the other.
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  const content = !title
    ? body
    : !body
      ? title
      : b.includes(t)
        ? body
        : t.includes(b)
          ? title
          : `${title}\n\n${body}`;
  if (!content) return null;
  const rating = Number(e["im:rating"]?.label);
  const hasRating = Number.isFinite(rating) && rating >= 1 && rating <= 5;
  const version = e["im:version"]?.label ?? "";
  const votes = Number(e["im:voteCount"]?.label ?? 0) || 0;
  const author = e.author?.name?.label ?? "";
  return {
    monitorId,
    source: "appstore",
    externalId: id,
    stream,
    url: `https://apps.apple.com/${cc}/app/id${appId}?see-all=reviews`,
    authorId: e.author?.uri?.label ?? author,
    authorHandle: author,
    authorName: author,
    authorFollowers: null,
    content,
    postedAt: clampFutureDate(postedAt),
    parentExternalId: "",
    context: {
      channel_name: `App Store (${cc})`,
      ...(hasRating ? { rating } : {}),
      ...(version ? { app_version: version } : {}),
    },
    metrics: {
      rating: hasRating ? rating : null,
      version,
      vote_sum: Number(e["im:voteSum"]?.label ?? 0) || 0,
      vote_count: votes,
      storefront: cc,
    },
    impressions: null, // Apple exposes no view counts (D15 — labeled proxy)
    engagement: votes,
  };
}

async function fetchPage(
  cc: string,
  appId: string,
  page: number,
): Promise<{ status: number; feed: RssFeed | null }> {
  let res: Response;
  try {
    res = await fetch(feedUrl(cc, appId, page), { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new TransientError(`appstore fetch failed: ${String(err)}`);
  }
  // 400 is how the feed says "no such storefront" AND "past the last page";
  // the caller disambiguates by page number.
  if (res.status === 400) return { status: 400, feed: null };
  if (!res.ok) throw errorFromStatus(res.status, await res.text().then((t) => t.slice(0, 300)));
  return { status: res.status, feed: (await res.json()) as RssFeed };
}

function newestIso(items: RawItem[]): string | null {
  if (items.length === 0) return null;
  return new Date(Math.max(...items.map((i) => i.postedAt.getTime()))).toISOString();
}

/** `reviews/<cc>/<target uuid>` -> storefront code. */
function storefrontOf(stream: string): string | null {
  const parts = stream.split("/");
  return parts[0] === "reviews" && parts[1] ? parts[1] : null;
}

export const appstoreAdapter: SourceAdapter = {
  source: "appstore",

  async status() {
    // No credential exists for this source: it is always configured (D22).
    return { configured: true, detail: "public feed — no credentials needed" };
  },

  async testConnection() {
    // Nothing to test: there is no credential and no Connections card calls
    // this. The feed itself is exercised on the first fetch of any target.
    return { ok: true, message: "public feed — no credentials required" };
  },

  streams(monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    const out: StreamDef[] = [];
    for (const t of targets) {
      if (t.kind !== "app") continue;
      for (const cc of monitor.config.limits.appstore_storefronts) {
        out.push({ stream: `reviews/${cc}/${t.id}`, target: t });
      }
    }
    return out;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
    if (fixtureMode()) {
      if (cursor) return { items: [], nextCursor: null };
      const entries = await loadFixture<RssEntry[]>("appstore");
      const items = entries
        .map((e) => parseReview(monitor.id, stream.stream, "us", "000000000", e))
        .filter((i): i is RawItem => i !== null);
      return { items, nextCursor: newestIso(items), droppedCount: entries.length - items.length };
    }

    // Forward-only first sync (SPEC §9): backfill is a deliberate action.
    if (!cursor) return { items: [], nextCursor: new Date().toISOString() };

    const cc = storefrontOf(stream.stream);
    const appId = parseAppId(stream.target?.value ?? "");
    if (!cc || !appId) {
      throw new SystemicError(
        `appstore target is not an App Store id or URL: ${stream.target?.value ?? stream.stream}`,
      );
    }
    const cursorMs = new Date(cursor).getTime();

    const newer: RawItem[] = [];
    let dropped = 0;
    let feedCapped = false;
    /** Set when a page came back empty/short below `last` or without links (review N1). */
    let anomalyPage: number | null = null;

    for (let page = 1; page <= APPSTORE_FEED_PAGE_CAP; page++) {
      const { status, feed } = await fetchPage(cc, appId, page);
      if (status === 400 || !feed) {
        // Page 1 rejected = unknown storefront/app (operator error → breaker).
        if (page === 1) throw new SystemicError(`appstore feed rejected ${cc}/${appId} (400)`);
        // Past the last page Apple answers 200 with zero entries (probed on
        // apps with 0–1 reviews), never 400 — so a 400 mid-walk is a hiccup,
        // not the end of the feed. Hold rather than advance over reviews that
        // may exist; refetching the pages already walked is idempotent (review S6).
        throw new TransientError(`appstore feed answered 400 on page ${page} after ${page - 1} full page(s); cursor held`);
      }
      const entries = entriesOf(feed);
      const lastPage = lastPageOf(feed);
      if (entries.length === 0 && lastPage !== null && page > lastPage) break; // past the end
      if (entries.length === 0) {
        // A transient blank page, not the end. Page 1 with no links at all is
        // also what an unserved storefront looks like — hold quietly; a later
        // page, or a page 1 whose links claim more pages, is a gap worth saying.
        if (page > 1 || (lastPage !== null && lastPage > 1)) anomalyPage = page;
        break;
      }
      let reachedCursor = false;
      for (const e of entries) {
        const item = parseReview(monitor.id, stream.stream, cc, appId, e);
        if (!item) {
          dropped++;
          continue;
        }
        // Strictly older ends the walk. An entry in the cursor's own second may
        // be a NEW review (`updated` is second-granular); keep it and let the
        // dedupe below drop it if it was already stored (review F1).
        if (item.postedAt.getTime() < cursorMs) {
          reachedCursor = true;
          continue;
        }
        newer.push(item);
      }
      if (reachedCursor) break;
      // Cap detection BEFORE the `last` break: every real feed with 500+ reviews
      // reports last=10, the cap itself, so the break would strand the flag and
      // the lossy advance would go unrecorded (review N1, round 3). A short
      // page 10 is a clean end, not a cap.
      if (page === APPSTORE_FEED_PAGE_CAP && entries.length >= PAGE_SIZE) feedCapped = true;
      if (lastPage !== null && page >= lastPage) break; // the feed says this is the last page
      if (entries.length < PAGE_SIZE) {
        // Short page: an anomaly when the feed says more pages exist, and also
        // when it carries no usable `last` at all — without that link we cannot
        // tell a genuine end from a truncated response, and advancing would
        // skip the pages behind it for good. A real end page DOES carry `last`
        // (probed: Broadcasts p3 34 entries last=3, NetNewsWire p4 20/last=4),
        // so it breaks at the `page >= lastPage` check above and never lands
        // here — holding costs a repeated walk, never a small app's feed.
        if (lastPage === null || page < lastPage) anomalyPage = page;
        break;
      }
    }

    // The cursor advances over everything seen, edits included, so an edited
    // review is not re-walked on every tick. null = nothing newer = hold.
    const nextCursor = newestIso(newer);

    // Drop ids already stored ON THIS STREAM (edits, the boundary review):
    // a second row per edit would inflate the theme item count (review S1).
    // Before the anomaly exit too — that path re-walks the same pages every
    // tick, so it meets edits most (review N2, round 3).
    let items = newer;
    if (newer.length > 0) {
      const ids = newer.map((i) => i.externalId);
      const rows = await sql`
        select external_id from raw_items
        where monitor_id = ${monitor.id} and source = 'appstore'
          and stream = ${stream.stream} and external_id = any(${ids}::text[])`;
      const seen = new Set(rows.map((r) => r.external_id as string));
      if (seen.size > 0) items = newer.filter((i) => !seen.has(i.externalId));
    }

    if (anomalyPage !== null) {
      // Store what was parsed, HOLD the cursor, say so: the next tick re-walks.
      if (!(await hasEventToday(sql, monitor.id, "coverage_gap", stream.stream))) {
        await logEvent(sql, {
          monitorId: monitor.id,
          source: "appstore",
          stream: stream.stream,
          level: "warn",
          kind: "coverage_gap",
          message: `Apple served an empty or short page ${anomalyPage} mid-feed; cursor held so the walk repeats next run (transient on Apple's side)`,
        });
      }
      return { items, nextCursor: null, ...(dropped > 0 ? { droppedCount: dropped } : {}) };
    }

    // Lossy-but-covered: 500 reviews newer than the cursor and Apple has no
    // page 11. Its own kind and a per-stream debounce, so an advisory
    // coverage_gap from another source or storefront cannot silence it
    // (review F2); only when the cursor really moves (review F3).
    if (feedCapped && nextCursor !== null && !(await hasEventToday(sql, monitor.id, "coverage_lost", stream.stream))) {
      await logEvent(sql, {
        monitorId: monitor.id,
        source: "appstore",
        stream: stream.stream,
        level: "error",
        kind: "coverage_lost",
        message: `Apple's feed exposes only the newest ${PAGE_SIZE * APPSTORE_FEED_PAGE_CAP} reviews per storefront and all of them were newer than the cursor; older reviews since the cursor are unreachable and the cursor advanced past them (shorten cadence_minutes.fetch for this app)`,
      });
    }

    return {
      items,
      nextCursor,
      ...(dropped > 0 ? { droppedCount: dropped } : {}),
    };
  },
};
