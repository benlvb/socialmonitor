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
 * is the review's creation time until the author edits it.
 *
 * Streams: one per (target, storefront) named `reviews/<cc>/<target uuid>`; the
 * uuid suffix keeps the target-deletion cleanup (`stream like '%/<id>'`) working.
 *
 * Cursor: ISO `updated` of the newest review seen. Walk newest-first until an
 * entry at or before the cursor appears (window covered), the feed runs out
 * (short page), or Apple's page cap — which also counts as covered: nothing
 * older is obtainable, so the cursor ADVANCES with a coverage_gap warning
 * instead of holding forever. Only our own `limits.max_pages_per_fetch` holds.
 *
 * Edited reviews resurface with a new `updated` but the same id. The PK on
 * raw_items includes posted_at, so a second row would double-count the author;
 * ids already stored are dropped and the first-seen text is kept.
 */

const RSS_HOST = "https://itunes.apple.com";
const PAGE_SIZE = 50;
/** Apple serves at most this many pages per storefront. */
export const APPSTORE_FEED_PAGE_CAP = 10;
/** A long-lived public app id, used only to prove the feed host answers. */
const PROBE_APP_ID = "310633997";

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
interface RssFeed {
  feed?: { entry?: RssEntry | RssEntry[] };
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
  const content = [title, body].filter(Boolean).join("\n\n");
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
    try {
      const { status, feed } = await fetchPage("us", PROBE_APP_ID, 1);
      return status === 200 && feed
        ? { ok: true, message: "customer-reviews feed reachable" }
        : { ok: false, message: `feed returned ${status}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
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
    const maxPages = Math.min(monitor.config.limits.max_pages_per_fetch, APPSTORE_FEED_PAGE_CAP);

    const newer: RawItem[] = [];
    let dropped = 0;
    let completed = false;
    let feedCapped = false;

    for (let page = 1; page <= maxPages; page++) {
      const { status, feed } = await fetchPage(cc, appId, page);
      if (status === 400 || !feed) {
        // Page 1 rejected = unknown storefront/app (operator error → breaker);
        // a later page rejected = the feed ended early → window covered.
        if (page === 1) throw new SystemicError(`appstore feed rejected ${cc}/${appId} (400)`);
        completed = true;
        break;
      }
      const entries = entriesOf(feed);
      let reachedCursor = false;
      for (const e of entries) {
        const item = parseReview(monitor.id, stream.stream, cc, appId, e);
        if (!item) {
          dropped++;
          continue;
        }
        if (item.postedAt.getTime() <= cursorMs) {
          reachedCursor = true; // walked back to the cursor: window covered
          continue;
        }
        newer.push(item);
      }
      if (reachedCursor || entries.length < PAGE_SIZE) {
        completed = true;
        break;
      }
      if (page === APPSTORE_FEED_PAGE_CAP) {
        // Apple has nothing older to give: covered, but lossy — say so.
        completed = true;
        feedCapped = true;
        break;
      }
    }

    // The cursor advances over everything seen, edits included, so an edited
    // review is not re-walked on every tick.
    const nextCursor = newestIso(newer);

    // Drop ids already stored (edits): a second row per edit would double-count.
    let items = newer;
    if (newer.length > 0) {
      const ids = newer.map((i) => i.externalId);
      const rows = await sql`
        select external_id from raw_items
        where monitor_id = ${monitor.id} and source = 'appstore'
          and external_id = any(${ids}::text[])`;
      const seen = new Set(rows.map((r) => r.external_id as string));
      if (seen.size > 0) items = newer.filter((i) => !seen.has(i.externalId));
    }

    if (!completed && !(await hasEventToday(sql, monitor.id, "coverage_gap"))) {
      await logEvent(sql, {
        monitorId: monitor.id,
        source: "appstore",
        stream: stream.stream,
        level: "warn",
        kind: "coverage_gap",
        message: `more than ${maxPages} feed pages since the cursor; cursor held, the remainder resumes next run (raise limits.max_pages_per_fetch, max ${APPSTORE_FEED_PAGE_CAP})`,
      });
    }
    if (feedCapped && !(await hasEventToday(sql, monitor.id, "coverage_gap"))) {
      await logEvent(sql, {
        monitorId: monitor.id,
        source: "appstore",
        stream: stream.stream,
        level: "warn",
        kind: "coverage_gap",
        message: `Apple's feed exposes only the newest ${PAGE_SIZE * APPSTORE_FEED_PAGE_CAP} reviews per storefront; ${newer.length} fetched, older reviews since the cursor are unreachable — cursor advanced`,
      });
    }

    return {
      items,
      nextCursor: completed ? nextCursor : null,
      ...(dropped > 0 ? { droppedCount: dropped } : {}),
    };
  },
};
