import { TransientError, errorFromStatus, type RawItem } from "@socialmonitor/shared";
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

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(creds: Credentials): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
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
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 300) * 1000 };
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
    postedAt: new Date(d.created_utc * 1000),
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

    const target = stream.target;
    let raw: RedditThing[] = [];

    if (stream.stream === "comments") {
      return fetchComments(ctx, creds);
    } else if (target?.kind === "subreddit") {
      const data = (await apiGet(creds, `/r/${target.value}/new`, { limit: "100" })) as { data?: { children?: RedditThing[] } };
      raw = data.data?.children ?? [];
    } else if (target?.kind === "keyword") {
      const data = (await apiGet(creds, "/search", { q: target.value, sort: "new", limit: "100", type: "link" })) as { data?: { children?: RedditThing[] } };
      raw = data.data?.children ?? [];
    } else if (target?.kind === "user") {
      const data = (await apiGet(creds, `/user/${target.value}/overview`, { sort: "new", limit: "100" })) as { data?: { children?: RedditThing[] } };
      raw = data.data?.children ?? [];
    }

    const parsed = raw.map((t) => parseThing(monitor.id, stream.stream, t)).filter((i): i is RawItem => i !== null);
    const items = newerThan(parsed, cursor);
    return {
      items,
      nextCursor: nextCursorFrom(items, cursor),
      droppedCount: raw.length - parsed.length,
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
      depth: "1",
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
  const fresh = newerThan(items, cursor);
  return { items: fresh, nextCursor: nextCursorFrom(fresh, cursor), droppedCount: dropped };
}
