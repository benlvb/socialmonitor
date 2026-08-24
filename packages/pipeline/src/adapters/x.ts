import { TransientError, SystemicError, errorFromStatus, type ItemRef, type MetricsRow, type RawItem } from "@socialmonitor/shared";
import type { Db } from "@socialmonitor/db";
import { getStreamState, updateStreamMeta, type MonitorRow, type TargetRow } from "../db/repos";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { resolveCredentials } from "./credentials";
import { fixtureMode, loadFixture } from "./fixtures";

/**
 * X adapter over a hosted scraper API — twitterapi.io (D5).
 * Transport-swappable: the official X API replaces this class later without
 * touching the pipeline. Field contract per SPEC section 5.
 * Cursor: epoch seconds of the newest tweet seen (string).
 * NOTE: field names verified against fixtures; live shakedown expected at
 * activation (D22 trade-off).
 */

const BASE = "https://api.twitterapi.io";

interface ApiTweet {
  id: string;
  url?: string;
  text: string;
  createdAt: string; // "Tue Dec 10 07:00:30 +0000 2024"
  author?: { id?: string; userName?: string; name?: string; followers?: number };
  likeCount?: number;
  replyCount?: number;
  retweetCount?: number;
  quoteCount?: number;
  viewCount?: number;
  isReply?: boolean;
  inReplyToId?: string;
}

interface SearchPage {
  tweets: ApiTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
}

function parseTweet(monitorId: string, stream: string, t: ApiTweet): RawItem | null {
  if (!t?.id || typeof t.text !== "string") return null;
  const postedAt = new Date(t.createdAt);
  if (Number.isNaN(postedAt.getTime())) return null;
  const likes = t.likeCount ?? 0;
  const replies = t.replyCount ?? 0;
  const rts = t.retweetCount ?? 0;
  const quotes = t.quoteCount ?? 0;
  return {
    monitorId,
    source: "x",
    externalId: t.id,
    stream,
    url: t.url ?? `https://x.com/${t.author?.userName ?? "i"}/status/${t.id}`,
    authorId: t.author?.id ?? "",
    authorHandle: t.author?.userName ?? "",
    authorName: t.author?.name ?? "",
    authorFollowers: t.author?.followers ?? null,
    content: t.text,
    postedAt,
    parentExternalId: t.inReplyToId ?? "",
    context: {},
    metrics: {
      likes,
      replies,
      retweets: rts,
      quotes,
      views: t.viewCount ?? null,
    },
    impressions: t.viewCount ?? null,
    engagement: likes + replies + rts + quotes,
  };
}

async function apiGet(key: string, pathname: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TransientError(`x fetch failed: ${String(err)}`);
  }
  if (!res.ok) throw errorFromStatus(res.status, await res.text().then((t) => t.slice(0, 300)));
  return res.json();
}

/**
 * Daily API-read budget (audit #15): counts actual API calls in stream meta —
 * stored-row counts cannot cap spend (duplicates store nothing) and were
 * checked only once per run instead of per page.
 */
async function takeReadBudget(sql: Db, monitor: MonitorRow): Promise<boolean> {
  const stream = "xreads_budget";
  const state = await getStreamState(sql, monitor.id, "x", stream);
  const meta = (state?.cursor_meta ?? {}) as { day?: string; count?: number };
  const today = new Date().toISOString().slice(0, 10);
  const count = meta.day === today ? (meta.count ?? 0) : 0;
  if (count >= monitor.config.budgets.x_reads_per_day) return false;
  await updateStreamMeta(sql, monitor.id, "x", stream, { day: today, count: count + 1 });
  return true;
}

export const xAdapter: SourceAdapter = {
  source: "x",

  async status(sql, ownerId) {
    if (fixtureMode()) return { configured: true, detail: "fixture mode" };
    const creds = await resolveCredentials(sql, ownerId, "x_scraper");
    return creds
      ? { configured: true }
      : { configured: false, detail: "TWITTERAPI_IO_KEY not configured" };
  },

  async testConnection(sql, ownerId) {
    const creds = await resolveCredentials(sql, ownerId, "x_scraper");
    if (!creds) return { ok: false, message: "no credentials" };
    try {
      await apiGet(creds.TWITTERAPI_IO_KEY!, "/twitter/tweet/advanced_search", {
        query: "hello",
        queryType: "Latest",
      });
      return { ok: true, message: "search endpoint reachable" };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  streams(_monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    const out: StreamDef[] = [];
    for (const t of targets) {
      if (t.kind === "keyword") out.push({ stream: `search/${t.id}`, target: t });
      if (t.kind === "account") {
        out.push({ stream: `account/${t.id}`, target: t });
        // Un-gated mention stream (SPEC: keyword-gated queries miss ~30% of
        // actionable mentions because users don't use your vocabulary).
        out.push({ stream: `mentions/${t.id}`, target: t });
      }
    }
    return out;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
    if (fixtureMode()) {
      if (cursor) return { items: [], nextCursor: null };
      const tweets = await loadFixture<ApiTweet[]>("x");
      const items = tweets
        .map((t) => parseTweet(monitor.id, stream.stream, t))
        .filter((i): i is RawItem => i !== null);
      const newest = Math.max(...items.map((i) => i.postedAt.getTime() / 1000), 0);
      return { items, nextCursor: String(Math.floor(newest)), droppedCount: tweets.length - items.length };
    }

    const creds = await resolveCredentials(sql, monitor.owner_id, "x_scraper");
    if (!creds) return { items: [], nextCursor: null };

    // Forward-only first sync (audit #16): backfill is a deliberate action.
    if (!cursor) {
      return { items: [], nextCursor: String(Math.floor(Date.now() / 1000)) };
    }

    const target = stream.target!;
    const isMentions = stream.stream.startsWith("mentions/");
    let query = isMentions
      ? `@${target.value.replace(/^@/, "")}`
      : target.kind === "account"
        ? `from:${target.value}`
        : target.value;
    query += ` since_time:${cursor}`;

    const items: RawItem[] = [];
    let dropped = 0;
    let pageCursor: string | undefined;
    const maxPages = monitor.config.limits.max_pages_per_fetch;

    for (let page = 0; page < maxPages; page++) {
      // Budget check per API call, not per run (audit #15).
      if (!(await takeReadBudget(sql, monitor))) {
        console.log(`[x] ${monitor.name}: daily API read budget spent`);
        break;
      }
      const params: Record<string, string> = { query, queryType: "Latest" };
      if (pageCursor) params.cursor = pageCursor;
      const data = (await apiGet(
        creds.TWITTERAPI_IO_KEY!,
        "/twitter/tweet/advanced_search",
        params,
      )) as SearchPage;
      const tweets = data.tweets ?? [];
      for (const t of tweets) {
        const item = parseTweet(monitor.id, stream.stream, t);
        if (item) items.push(item);
        else dropped++; // per-item: drop and continue (SPEC error classes)
      }
      if (!data.has_next_page || !data.next_cursor || tweets.length === 0) break;
      pageCursor = data.next_cursor;
    }

    const newest = items.reduce((max, i) => Math.max(max, i.postedAt.getTime() / 1000), 0);
    return {
      items,
      nextCursor: newest > 0 ? String(Math.floor(newest)) : null,
      droppedCount: dropped,
    };
  },

  async refreshMetrics(sql: Db, monitor: MonitorRow, refs: ItemRef[]): Promise<MetricsRow[]> {
    if (fixtureMode()) return [];
    const creds = await resolveCredentials(sql, monitor.owner_id, "x_scraper");
    if (!creds || refs.length === 0) return [];
    const out: MetricsRow[] = [];
    // Batch tweet lookup, 100 ids per call.
    for (let i = 0; i < refs.length; i += 100) {
      const ids = refs.slice(i, i + 100).map((r) => r.externalId);
      const data = (await apiGet(creds.TWITTERAPI_IO_KEY!, "/twitter/tweets", {
        tweet_ids: ids.join(","),
      })) as { tweets?: ApiTweet[] };
      for (const t of data.tweets ?? []) {
        if (!t?.id) continue;
        const likes = t.likeCount ?? 0;
        out.push({
          externalId: t.id,
          metrics: {
            likes,
            replies: t.replyCount ?? 0,
            retweets: t.retweetCount ?? 0,
            quotes: t.quoteCount ?? 0,
            views: t.viewCount ?? null,
          },
          impressions: t.viewCount ?? null,
          engagement: likes + (t.replyCount ?? 0) + (t.retweetCount ?? 0) + (t.quoteCount ?? 0),
        });
      }
    }
    return out;
  },
};
