import { TransientError, errorFromStatus, type ItemRef, type MetricsRow, type RawItem } from "@socialmonitor/shared";
import type { Db } from "@socialmonitor/db";
import type { MonitorRow, TargetRow } from "../db/repos";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { resolveCredentials, type Credentials } from "./credentials";
import { fixtureMode, loadFixture } from "./fixtures";
import { getStreamState, updateStreamMeta } from "../db/repos";

/**
 * YouTube adapter (D6): videos + comments streams, both on by default.
 * Quota reality: search.list = 100 units; playlistItems/commentThreads/videos = 1.
 * Keyword search is budgeted per monitor per day (config.budgets.youtube_searches_per_day);
 * comments poll only videos younger than N days. Cursor: ISO publishedAt.
 */

const API = "https://www.googleapis.com/youtube/v3";

async function apiGet(creds: Credentials, pathname: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", creds.YOUTUBE_API_KEY!);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new TransientError(`youtube fetch failed: ${String(err)}`);
  }
  if (!res.ok) throw errorFromStatus(res.status, await res.text().then((t) => t.slice(0, 300)));
  return res.json();
}

interface YtVideoItem {
  id?: string | { videoId?: string };
  snippet?: {
    publishedAt?: string;
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    resourceId?: { videoId?: string };
    topLevelComment?: unknown;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

function videoId(item: YtVideoItem): string | null {
  if (typeof item.id === "string") return item.id;
  return item.id?.videoId ?? item.snippet?.resourceId?.videoId ?? null;
}

function parseVideo(monitorId: string, stream: string, item: YtVideoItem): RawItem | null {
  const id = videoId(item);
  const s = item.snippet;
  if (!id || !s?.publishedAt) return null;
  const content = [s.title, s.description].filter(Boolean).join("\n\n");
  if (!content) return null;
  return {
    monitorId,
    source: "youtube",
    externalId: `video:${id}`,
    stream,
    url: `https://www.youtube.com/watch?v=${id}`,
    authorId: s.channelId ?? "",
    authorHandle: s.channelTitle ?? "",
    authorName: s.channelTitle ?? "",
    authorFollowers: null,
    content,
    postedAt: new Date(s.publishedAt),
    parentExternalId: "",
    context: { channel_name: s.channelTitle ?? "" },
    metrics: {},
    impressions: null, // filled by metrics refresh (videos.list statistics)
    engagement: null,
  };
}

interface YtCommentThread {
  id?: string;
  snippet?: {
    videoId?: string;
    topLevelComment?: {
      snippet?: {
        textDisplay?: string;
        textOriginal?: string;
        authorDisplayName?: string;
        authorChannelId?: { value?: string };
        likeCount?: number;
        publishedAt?: string;
      };
    };
  };
}

function parseComment(monitorId: string, thread: YtCommentThread, parentText: string): RawItem | null {
  const c = thread.snippet?.topLevelComment?.snippet;
  const vid = thread.snippet?.videoId;
  if (!thread.id || !c?.publishedAt || !vid) return null;
  const text = c.textOriginal ?? c.textDisplay ?? "";
  if (!text) return null;
  return {
    monitorId,
    source: "youtube",
    externalId: `comment:${thread.id}`,
    stream: "comments",
    url: `https://www.youtube.com/watch?v=${vid}&lc=${thread.id}`,
    authorId: c.authorChannelId?.value ?? "",
    authorHandle: c.authorDisplayName ?? "",
    authorName: c.authorDisplayName ?? "",
    authorFollowers: null,
    content: text,
    postedAt: new Date(c.publishedAt),
    parentExternalId: `video:${vid}`,
    context: parentText ? { parent_text: parentText } : {},
    metrics: { likes: c.likeCount ?? 0 },
    impressions: null,
    engagement: c.likeCount ?? 0,
  };
}

function newerThan(items: RawItem[], cursor: string | null): RawItem[] {
  if (!cursor) return items;
  const after = new Date(cursor).getTime();
  return items.filter((i) => i.postedAt.getTime() > after);
}

function nextCursorFrom(items: RawItem[], cursor: string | null): string | null {
  if (items.length === 0) return null;
  const newest = items.reduce((m, i) => Math.max(m, i.postedAt.getTime()), 0);
  if (cursor && newest <= new Date(cursor).getTime()) return null;
  return new Date(newest).toISOString();
}

/** Daily search budget tracked in a dedicated stream row's meta (runtime-editable, D13). */
async function takeSearchBudget(sql: Db, monitor: MonitorRow): Promise<boolean> {
  const stream = "ytsearch_budget";
  const state = await getStreamState(sql, monitor.id, "youtube", stream);
  const meta = (state?.cursor_meta ?? {}) as { day?: string; count?: number };
  const today = new Date().toISOString().slice(0, 10);
  const count = meta.day === today ? (meta.count ?? 0) : 0;
  if (count >= monitor.config.budgets.youtube_searches_per_day) return false;
  await updateStreamMeta(sql, monitor.id, "youtube", stream, { day: today, count: count + 1 });
  return true;
}

export const youtubeAdapter: SourceAdapter = {
  source: "youtube",

  async status(sql, ownerId) {
    if (fixtureMode()) return { configured: true, detail: "fixture mode" };
    const creds = await resolveCredentials(sql, ownerId, "youtube");
    return creds ? { configured: true } : { configured: false, detail: "YOUTUBE_API_KEY not configured" };
  },

  async testConnection(sql, ownerId) {
    const creds = await resolveCredentials(sql, ownerId, "youtube");
    if (!creds) return { ok: false, message: "no credentials" };
    try {
      await apiGet(creds, "/videos", { part: "id", chart: "mostPopular", maxResults: "1" });
      return { ok: true, message: "data api reachable" };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  streams(monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    const out: StreamDef[] = [];
    const t = monitor.config.toggles;
    for (const target of targets) {
      if (target.kind === "channel" && t.youtube_videos) out.push({ stream: `channel/${target.id}`, target });
      if (target.kind === "keyword" && t.youtube_videos) out.push({ stream: `search/${target.id}`, target });
    }
    if (t.youtube_comments && out.length > 0) out.push({ stream: "comments" });
    return out;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
    if (fixtureMode()) {
      if (cursor) return { items: [], nextCursor: null };
      if (stream.stream === "comments") {
        const threads = await loadFixture<YtCommentThread[]>("youtube-comments");
        const items = threads.map((t) => parseComment(monitor.id, t, "")).filter((i): i is RawItem => i !== null);
        return { items, nextCursor: nextCursorFrom(items, null), droppedCount: threads.length - items.length };
      }
      const vids = await loadFixture<YtVideoItem[]>("youtube");
      const items = vids.map((v) => parseVideo(monitor.id, stream.stream, v)).filter((i): i is RawItem => i !== null);
      return { items, nextCursor: nextCursorFrom(items, null), droppedCount: vids.length - items.length };
    }

    const creds = await resolveCredentials(sql, monitor.owner_id, "youtube");
    if (!creds) return { items: [], nextCursor: null };

    if (stream.stream === "comments") return fetchComments(ctx, creds);

    const target = stream.target!;
    let rawItems: YtVideoItem[] = [];

    if (target.kind === "channel") {
      // Resolve channel -> uploads playlist (1 unit), then list uploads (1 unit).
      const idParam: Record<string, string> = target.value.startsWith("UC")
        ? { id: target.value }
        : { forHandle: target.value.startsWith("@") ? target.value : `@${target.value}` };
      const ch = (await apiGet(creds, "/channels", {
        part: "contentDetails",
        ...idParam,
      })) as { items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] };
      const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) throw errorFromStatus(404, `channel not found: ${target.value}`);
      const pl = (await apiGet(creds, "/playlistItems", {
        part: "snippet",
        playlistId: uploads,
        maxResults: "50",
      })) as { items?: YtVideoItem[] };
      rawItems = pl.items ?? [];
    } else {
      // Keyword search — 100 units; budgeted.
      if (!(await takeSearchBudget(sql, monitor))) {
        console.log(`[youtube] ${monitor.name}: daily search budget spent`);
        return { items: [], nextCursor: null };
      }
      const params: Record<string, string> = {
        part: "snippet",
        q: target.value,
        type: "video",
        order: "date",
        maxResults: "50",
      };
      if (cursor) params.publishedAfter = cursor;
      const data = (await apiGet(creds, "/search", params)) as { items?: YtVideoItem[] };
      rawItems = data.items ?? [];
    }

    const parsed = rawItems.map((v) => parseVideo(monitor.id, stream.stream, v)).filter((i): i is RawItem => i !== null);
    const items = newerThan(parsed, cursor);
    return { items, nextCursor: nextCursorFrom(items, cursor), droppedCount: rawItems.length - parsed.length };
  },

  async refreshMetrics(sql: Db, monitor: MonitorRow, refs: ItemRef[]): Promise<MetricsRow[]> {
    if (fixtureMode()) return [];
    const creds = await resolveCredentials(sql, monitor.owner_id, "youtube");
    if (!creds) return [];
    const videoRefs = refs.filter((r) => r.externalId.startsWith("video:"));
    const out: MetricsRow[] = [];
    for (let i = 0; i < videoRefs.length; i += 50) {
      const ids = videoRefs.slice(i, i + 50).map((r) => r.externalId.replace("video:", ""));
      const data = (await apiGet(creds, "/videos", {
        part: "statistics",
        id: ids.join(","),
      })) as { items?: YtVideoItem[] };
      for (const v of data.items ?? []) {
        const id = videoId(v);
        if (!id || !v.statistics) continue;
        const views = Number(v.statistics.viewCount ?? 0);
        const likes = Number(v.statistics.likeCount ?? 0);
        const comments = Number(v.statistics.commentCount ?? 0);
        out.push({
          externalId: `video:${id}`,
          metrics: { views, likes, comments },
          impressions: views,
          engagement: likes + comments,
        });
      }
    }
    return out;
  },
};

/** Comments on recent videos already in raw_items (<= N days, D6). */
async function fetchComments(ctx: FetchContext, creds: Credentials): Promise<FetchResult> {
  const { sql, monitor, cursor } = ctx;
  const maxAge = monitor.config.limits.youtube_comment_max_video_age_days;
  const videos = await sql`
    select external_id, content from raw_items
    where monitor_id = ${monitor.id} and source = 'youtube'
      and external_id like 'video:%'
      and posted_at > now() - make_interval(days => ${maxAge})
    order by posted_at desc limit 25`;

  const items: RawItem[] = [];
  let dropped = 0;
  for (const v of videos) {
    const vid = (v.external_id as string).replace("video:", "");
    const parentText = (v.content as string).slice(0, 400);
    let data: { items?: YtCommentThread[] };
    try {
      data = (await apiGet(creds, "/commentThreads", {
        part: "snippet",
        videoId: vid,
        order: "time",
        maxResults: "100",
        textFormat: "plainText",
      })) as { items?: YtCommentThread[] };
    } catch (err) {
      // Comments disabled on a video is per-item, not systemic.
      dropped++;
      continue;
    }
    for (const t of data.items ?? []) {
      const item = parseComment(monitor.id, t, parentText);
      if (item) items.push(item);
      else dropped++;
    }
  }
  const fresh = newerThan(items, cursor);
  return { items: fresh, nextCursor: nextCursorFrom(fresh, cursor), droppedCount: dropped };
}
