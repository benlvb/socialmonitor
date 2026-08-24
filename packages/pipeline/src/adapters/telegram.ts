import { SystemicError, TransientError, clampFutureDate, type RawItem } from "@socialmonitor/shared";
import type { MonitorRow, TargetRow } from "../db/repos";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { resolveCredentials, type Credentials } from "./credentials";
import { fixtureMode, loadFixture } from "./fixtures";

/**
 * Telegram adapter via MTProto user client on a DEDICATED account (D8).
 * Public channels/groups by username; pull-based getMessages(minId) fits the
 * cursor model exactly. GramJS ("telegram" npm package) is imported lazily so
 * an unconfigured worker never loads it. Cursor: message id (string).
 * Conservative pacing: one channel fetch at a time, small page size.
 */

interface TgFixtureMessage {
  id: number;
  channel: string;
  text: string;
  date: number; // epoch seconds
  views?: number;
  forwards?: number;
  replies?: number;
  author?: string;
}

function parseFixture(monitorId: string, stream: string, m: TgFixtureMessage): RawItem | null {
  if (!m?.id || !m.text || !m.date) return null;
  return {
    monitorId,
    source: "telegram",
    externalId: `${m.channel}:${m.id}`,
    stream,
    url: `https://t.me/${m.channel}/${m.id}`,
    authorId: m.author ?? m.channel,
    authorHandle: m.author ?? m.channel,
    authorName: m.author ?? m.channel,
    authorFollowers: null,
    content: m.text,
    postedAt: new Date(m.date * 1000),
    parentExternalId: "",
    context: { channel_name: m.channel },
    metrics: { views: m.views ?? null, forwards: m.forwards ?? 0, replies: m.replies ?? 0 },
    impressions: m.views ?? null,
    engagement: (m.forwards ?? 0) + (m.replies ?? 0),
  };
}

// GramJS client cache, keyed by credentials so a rotated session takes effect.
let clientCache: { key: string; promise: Promise<unknown> } | null = null;

async function getClient(creds: Credentials): Promise<any> {
  const cacheKey = `${creds.TELEGRAM_MTPROTO_API_ID}:${(creds.TELEGRAM_MTPROTO_SESSION ?? "").slice(-16)}`;
  if (!clientCache || clientCache.key !== cacheKey) {
    const promise = (async () => {
      const { TelegramClient } = await import("telegram");
      const { StringSession } = await import("telegram/sessions/index.js");
      const client = new TelegramClient(
        new StringSession(creds.TELEGRAM_MTPROTO_SESSION!),
        Number(creds.TELEGRAM_MTPROTO_API_ID),
        creds.TELEGRAM_MTPROTO_API_HASH!,
        { connectionRetries: 3 },
      );
      await client.connect();
      return client;
    })().catch((err) => {
      clientCache = null;
      throw new TransientError(`telegram connect failed: ${String(err)}`);
    });
    clientCache = { key: cacheKey, promise };
  }
  return clientCache.promise;
}

export const telegramAdapter: SourceAdapter = {
  source: "telegram",

  async status(sql, ownerId) {
    if (fixtureMode()) return { configured: true, detail: "fixture mode" };
    const creds = await resolveCredentials(sql, ownerId, "telegram_mtproto");
    return creds
      ? { configured: true }
      : { configured: false, detail: "MTProto session not configured (dedicated account, D8)" };
  },

  async testConnection(sql, ownerId) {
    const creds = await resolveCredentials(sql, ownerId, "telegram_mtproto");
    if (!creds) return { ok: false, message: "no credentials" };
    try {
      const client = await getClient(creds);
      const me = await client.getMe();
      return { ok: true, message: `connected as ${me?.username ?? me?.id ?? "account"}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  streams(_monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    return targets
      .filter((t) => t.kind === "channel")
      .map((t) => ({ stream: `channel/${t.id}`, target: t }));
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
    if (fixtureMode()) {
      if (cursor) return { items: [], nextCursor: null };
      const msgs = await loadFixture<TgFixtureMessage[]>("telegram");
      const items = msgs.map((m) => parseFixture(monitor.id, stream.stream, m)).filter((i): i is RawItem => i !== null);
      const maxId = Math.max(...msgs.map((m) => m.id), 0);
      return { items, nextCursor: String(maxId), droppedCount: msgs.length - items.length };
    }

    const creds = await resolveCredentials(sql, monitor.owner_id, "telegram_mtproto");
    if (!creds) return { items: [], nextCursor: null };
    const username = stream.target!.value.replace(/^@/, "");

    const client = await getClient(creds);

    // Forward-only first sync (audit #16): record the newest id, fetch nothing.
    if (!cursor) {
      try {
        const newest = await client.getMessages(username, { limit: 1 });
        const newestId = Number(newest?.[0]?.id ?? 0);
        return { items: [], nextCursor: newestId > 0 ? String(newestId) : null };
      } catch (err) {
        const msg = String(err);
        if (/USERNAME_NOT_OCCUPIED|CHANNEL_PRIVATE|USERNAME_INVALID/.test(msg)) {
          throw new SystemicError(`telegram channel unavailable: ${username}: ${msg}`);
        }
        throw new TransientError(`telegram first-sync probe failed: ${msg}`);
      }
    }

    let messages: any[];
    try {
      // reverse: true iterates ASCENDING from minId — without it GramJS returns
      // the NEWEST N and a busy channel silently loses the middle (audit #10).
      messages = await client.getMessages(username, {
        minId: Number(cursor),
        reverse: true,
        limit: 300,
      });
    } catch (err) {
      const msg = String(err);
      if (/USERNAME_NOT_OCCUPIED|CHANNEL_PRIVATE|USERNAME_INVALID/.test(msg)) {
        throw new SystemicError(`telegram channel unavailable: ${username}: ${msg}`);
      }
      if (/FLOOD_WAIT/.test(msg)) {
        throw new TransientError(`telegram flood wait on ${username}`);
      }
      throw new TransientError(`telegram getMessages failed: ${msg}`);
    }

    const items: RawItem[] = [];
    let dropped = 0;
    let maxId = Number(cursor);
    for (const m of messages) {
      const id = Number(m?.id ?? 0);
      if (id > maxId) maxId = id;
      const text: string = m?.message ?? "";
      const date: number = Number(m?.date ?? 0);
      if (!id || !text || !date) {
        dropped++; // service messages / media-only: per-item drop
        continue;
      }
      const forwards = Number(m?.forwards ?? 0);
      const replies = Number(m?.replies?.replies ?? 0);
      const views = m?.views != null ? Number(m.views) : null;
      // Attribute to the real sender (audit #8): using the channel name for
      // every message collapsed author_count — the system's ranking metric —
      // to 1 for every group. Broadcast posts legitimately fall back to it.
      const senderId = m?.senderId != null ? String(m.senderId) : "";
      const senderHandle: string =
        (typeof m?.sender?.username === "string" && m.sender.username) ||
        (senderId ? `tg:${senderId}` : username);
      const senderName: string =
        [m?.sender?.firstName, m?.sender?.lastName].filter(Boolean).join(" ") || senderHandle;
      items.push({
        monitorId: monitor.id,
        source: "telegram",
        externalId: `${username}:${id}`,
        stream: stream.stream,
        url: `https://t.me/${username}/${id}`,
        authorId: senderId || username,
        authorHandle: senderHandle,
        authorName: senderName,
        authorFollowers: null,
        content: text,
        postedAt: clampFutureDate(new Date(date * 1000)),
        parentExternalId: m?.replyTo?.replyToMsgId ? `${username}:${m.replyTo.replyToMsgId}` : "",
        context: { channel_name: username },
        metrics: { views, forwards, replies },
        impressions: views,
        engagement: forwards + replies,
      });
    }

    return {
      items,
      nextCursor: maxId > 0 ? String(maxId) : null,
      droppedCount: dropped,
    };
  },
};
