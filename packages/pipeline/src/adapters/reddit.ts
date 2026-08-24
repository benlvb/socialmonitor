import { TransientError, clampFutureDate, errorFromStatus, type RawItem } from "@socialmonitor/shared";
import { hasEventToday } from "../db/repos";
import { logEvent } from "../events";
import type { Db } from "@socialmonitor/db";
import type { MonitorRow, TargetRow } from "../db/repos";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { resolveCredentials, type Credentials } from "./credentials";
import { fixtureMode, loadFixture } from "./fixtures";

/**
 * Reddit adapter (D7): subreddit_posts, keyword_search, user_posts, comments.
 * Cursor: epoch seconds of newest item (string) — robust against deleted
 * `before` anchors. Comments: posts <= N days old, top-level only, parent post
 * text as classifier context.
 */

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";
const UA = "socialmonitor/0.1 (feedback monitoring)";

let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

async function getToken(creds: Credentials): Promise<string> {
  const cacheKey = `${creds.REDDIT_CLIENT_ID}:${creds.REDDIT_USERNAME}`;
  if (cachedToken && cachedToken.key === cacheKey && Date.now() < cachedToken.expiresAt)
    return cachedToken.token;
  const basic = Buffer.from(`${creds.REDDIT_CLIENT_ID}:${creds.REDDIT_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: creds.REDDIT_USERNAME!,
    password: creds.REDDIT_PASSWORD!,
  });
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "User-Agent": UA },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TransientError(`reddit token fetch failed: ${String(err)}`);
  }
  if (!res.ok) throw errorFromStatus(res.status, "reddit token request failed");
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw errorFromStatus(401, "reddit token missing in response");
  cachedToken = { key: cacheKey, token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 300) * 1000 };
  return cachedToken.token;
}

async function apiGet(creds: Credentials, pathname: string, params: Record<string, string>): Promise<unknown> {
  const token = await getToken(creds);
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TransientError(`reddit fetch failed: ${String(err)}`);
  }
  if (!res.ok) throw errorFromStatus(res.status, await res.text().then((t) => t.slice(0, 300)));
  return res.json();
}

interface RedditThing {
  kind: string; // t1 comment, t3 post
  data: {
    id: string;
    name: string; // fullname
    title?: string;
    selftext?: string;
    body?: string;
    author?: string;
    created_utc?: number;
    permalink?: string;
    subreddit?: string;
    score?: number;
    num_comments?: number;
    upvote_ratio?: number;
    link_title?: string;
  };
}

function parseThing(monitorId: string, stream: string, thing: RedditThing, parentText = ""): RawItem | null {
  const d = thing?.data;
  if (!d?.name || !d.created_utc) return null;
  const isPost = thing.kind === "t3";
  const content = isPost
    ? [d.title, d.selftext].filter(Boolean).join("\n\n")
    : (d.body ?? "");
  if (!content) return null;
  const score = d.score ?? 0;
  const numComments = d.num_comments ?? 0;
  return {
    monitorId,
    source: "reddit",
    externalId: d.name,
    stream,
    url: d.permalink ? `https://www.reddit.com${d.permalink}` : "",
    authorId: d.author ?? "",
    authorHandle: d.author ?? "",
    authorName: d.author ?? "",
    authorFollowers: null,
    content,
    postedAt: clampFutureDate(new Date(d.created_utc * 1000)),
    parentExternalId: "",
    context: {
      ...(d.subreddit ? { channel_name: `r/${d.subreddit}` } : {}),
      ...(parentText ? { parent_text: parentText } : {}),
      ...(d.link_title && !isPost ? { parent_text: d.link_title } : {}),
    },
    metrics: { score, num_comments: numComments, upvote_ratio: d.upvote_ratio ?? null },
    impressions: null, // Reddit exposes no view counts (D15 — labeled proxy on dashboard)
    engagement: score + numComments,
  };
}

function newerThan(items: RawItem[], cursor: string | null): RawItem[] {
  if (!cursor) return items;
  const after = Number(cursor) * 1000;
  return items.filter((i) => i.postedAt.getTime() > after);
}

function nextCursorFrom(items: RawItem[], cursor: string | null): string | null {
  const newest = items.reduce((m, i) => Math.max(m, i.postedAt.getTime() / 1000), 0);
  if (newest === 0) return null;
  if (cursor && newest <= Number(cursor)) return null;
  return String(Math.floor(newest));
}

export const redditAdapter: SourceAdapter = {
  source: "reddit",

  async status(sql, ownerId) {
    if (fixtureMode()) return { configured: true, detail: "fixture mode" };
    const creds = await resolveCredentials(sql, ownerId, "reddit");
    return creds ? { configured: true } : { configured: false, detail: "reddit app credentials not configured" };
  },

  async testConnection(sql, ownerId) {
    const creds = await resolveCredentials(sql, ownerId, "reddit");
    if (!creds) return { ok: false, message: "no credentials" };
    try {
      await getToken(creds);
      return { ok: true, message: "oauth token issued" };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  streams(monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    const out: StreamDef[] = [];
    for (const t of targets) {
      if (t.kind === "subreddit") out.push({ stream: `subreddit/${t.id}`, target: t });
      if (t.kind === "keyword") out.push({ stream: `search/${t.id}`, target: t });
      if (t.kind === "user") out.push({ stream: `user/${t.id}`, target: t });
    }
    if (monitor.config.toggles.reddit_comments && out.length > 0) {
      out.push({ stream: "comments" });
    }
    return out;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
    if (fixtureMode()) {
      if (cursor) return { items: [], nextCursor: null };
      const things = await loadFixture<RedditThing[]>("reddit");
      const items = things
        .map((t) => parseThing(monitor.id, stream.stream, t))
        .filter((i): i is RawItem => i !== null);
      return { items, nextCursor: nextCursorFrom(items, null), droppedCount: things.length - items.length };
    }

    const creds = await resolveCredentials(sql, monitor.owner_id, "reddit");
    if (!creds) return { items: [], nextCursor: null };

    if (stream.stream === "comments") {
      return fetchComments(ctx, creds);
    }

    // Forward-only first sync (audit #16): backfill is a deliberate action.
    if (!cursor) {
      return { items: [], nextCursor: String(Math.floor(Date.now() / 1000)) };
    }

    const target = stream.target;
    let path: string;
    const params: Record<string, string> = { limit: "100" };
    if (target?.kind === "subreddit") {
      path = `/r/${target.value}/new`;
    } else if (target?.kind === "keyword") {
      path = "/search";
      params.q = target.value;
      params.sort = "new";
      params.type = "link";
    } else if (target?.kind === "user") {
      path = `/user/${target.value}/overview`;
      params.sort = "new";
    } else {
      return { items: [], nextCursor: null };
    }

    // Listings are reverse-chronological with `after` pagination. Walk pages
    // until the window is covered (an item older than the cursor) or the
    // listing ends; stopping at the page cap means the window is INCOMPLETE
    // and the cursor must hold, or the gap is skipped forever (audit #4).
    const maxPages = monitor.config.limits.max_pages_per_fetch;
    const cursorSecs = Number(cursor);
    const parsed: RawItem[] = [];
    let dropped = 0;
    let after: string | undefined;
    let completed = false;

    for (let page = 0; page < maxPages; page++) {
      const pageParams = after ? { ...params, after } : params;
      const data = (await apiGet(creds, path, pageParams)) as {
        data?: { children?: RedditThing[]; after?: string | null };
      };
      const children = data.data?.children ?? [];
      let reachedCursor = false;
      for (const thing of children) {
        const item = parseThing(monitor.id, stream.stream, thing);
        if (!item) {
          dropped++;
          continue;
        }
        if (item.postedAt.getTime() / 1000 <= cursorSecs) {
          reachedCursor = true; // walked back past the cursor: window covered
          continue;
        }
        parsed.push(item);
      }
      if (reachedCursor || !data.data?.after || children.length === 0) {
        completed = true;
        break;
      }
      after = data.data.after;
    }

    if (!completed && !(await hasEventToday(sql, monitor.id, "coverage_gap"))) {
      await logEvent(sql, {
        monitorId: monitor.id,
        source: "reddit",
        stream: stream.stream,
        level: "warn",
        kind: "coverage_gap",
        message: `listing still had pages after ${maxPages}; cursor held so the remainder is refetched next run`,
      });
    }

    return {
      items: parsed,
      // Hold on an incomplete walk — refetching overlap is free and idempotent.
      nextCursor: completed ? nextCursorFrom(parsed, cursor) : null,
      droppedCount: dropped,
    };
  },
};

/** Top-level comments on recent posts already in raw_items (depth 1, D7). */
async function fetchComments(ctx: FetchContext, creds: Credentials): Promise<FetchResult> {
  const { sql, monitor, cursor } = ctx;
  const maxAgeDays = monitor.config.limits.reddit_comment_max_post_age_days;
  const posts = await sql`
    select external_id, content from raw_items
    where monitor_id = ${monitor.id} and source = 'reddit'
      and stream not like 'comments%' and external_id like 't3_%'
      and posted_at > now() - make_interval(days => ${maxAgeDays})
    order by posted_at desc limit 20`;

  const items: RawItem[] = [];
  let dropped = 0;
  for (const post of posts) {
    const postId = (post.external_id as string).replace("t3_", "");
    const parentText = (post.content as string).slice(0, 400);
    const data = (await apiGet(creds, `/comments/${postId}`, {
      depth: String(monitor.config.limits.reddit_comment_depth),
      limit: "100",
      sort: "new",
    })) as { data?: { children?: RedditThing[] } }[];
    const children = data?.[1]?.data?.children ?? [];
    for (const c of children) {
      if (c.kind !== "t1") continue;
      const item = parseThing(monitor.id, "comments", c, parentText);
      if (item) items.push(item);
      else dropped++;
    }
  }
  // No cursor filter: fresh posts carry comments older than a global time
  // cursor, which would silently drop them (audit #11). Inserts are idempotent.
  return { items, nextCursor: null, droppedCount: dropped };
}
