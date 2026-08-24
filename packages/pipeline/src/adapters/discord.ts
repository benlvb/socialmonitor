import { TransientError, errorFromStatus, type RawItem } from "@socialmonitor/shared";
import type { Db } from "@socialmonitor/db";
import type { MonitorRow, TargetRow } from "../db/repos";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { resolveCredentials, type Credentials } from "./credentials";
import { fixtureMode, loadFixture } from "./fixtures";
import { logEvent } from "../events";
import { hasEventToday } from "../db/repos";

/**
 * Discord adapter (D9): bot REST polling, PER-CHANNEL snowflake cursors kept in
 * cursor_meta (audit #3 — a single guild-wide cursor silently skipped data),
 * forward-only first sync per channel, reply-chain + linear-neighbor context,
 * and the MESSAGE_CONTENT canary (audit #4a/#22: counts non-bot messages only,
 * requires 2 consecutive suspicious runs, and HOLDS all channel cursors while
 * suspicious so nothing is acknowledged as read).
 * Targets: kind=guild (value = guild id). One stream per guild.
 */

const API = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n;
const PAGES_PER_CHANNEL = 3;

export function datetimeToSnowflake(d: Date): string {
  return ((BigInt(d.getTime()) - DISCORD_EPOCH) << 22n).toString();
}

export function snowflakeToDatetime(snowflake: string): Date {
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH));
}

interface ApiMessage {
  id: string;
  channel_id: string;
  content?: string;
  author?: { id?: string; username?: string; global_name?: string; bot?: boolean };
  message_reference?: { message_id?: string; channel_id?: string };
  type?: number;
}

interface GuildMeta {
  /** per-channel last-processed snowflake */
  channels?: Record<string, string>;
  /** consecutive runs where all non-bot messages had empty content */
  canary_strikes?: number;
}

async function apiGet(
  creds: Credentials,
  pathname: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bot ${creds.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TransientError(`discord fetch failed: ${String(err)}`);
  }
  if (res.status === 429) {
    throw new TransientError("discord rate limited");
  }
  if (!res.ok) throw errorFromStatus(res.status, await res.text().then((t) => t.slice(0, 300)));
  return res.json();
}

function parseMessage(
  monitorId: string,
  stream: string,
  guildId: string,
  channelName: string,
  m: ApiMessage,
): RawItem | null {
  if (!m?.id || m.author?.bot) return null;
  const created = snowflakeToDatetime(m.id);
  return {
    monitorId,
    source: "discord",
    externalId: m.id,
    stream,
    url: `https://discord.com/channels/${guildId}/${m.channel_id}/${m.id}`,
    authorId: m.author?.id ?? "",
    authorHandle: m.author?.username ?? "",
    authorName: m.author?.global_name ?? m.author?.username ?? "",
    authorFollowers: null,
    content: m.content ?? "",
    postedAt: created,
    parentExternalId: m.message_reference?.message_id ?? "",
    context: { channel_name: channelName },
    metrics: {},
    impressions: null, // Discord has no public metrics (D15 — labeled proxy)
    engagement: null,
  };
}

/** Linear neighbors (12 msgs / 90 min) from raw_items — context for the classifier. */
async function attachNeighbors(sql: Db, monitorId: string, items: RawItem[]): Promise<void> {
  for (const item of items) {
    const channelId = item.url.split("/").at(-2);
    const rows = await sql`
      select author_handle, content, posted_at from raw_items
      where monitor_id = ${monitorId} and source = 'discord'
        and url like ${"%/" + channelId + "/%"}
        and posted_at >= ${item.postedAt} - interval '90 minutes'
        and posted_at < ${item.postedAt}
      order by posted_at desc limit 12`;
    if (rows.length > 0) {
      item.context.neighbors = [...rows]
        .reverse()
        .map((r) => ({ author: r.author_handle as string, text: (r.content as string).slice(0, 200) }));
    }
    if (item.parentExternalId) {
      const parent = await sql`
        select content from raw_items
        where monitor_id = ${monitorId} and source = 'discord' and external_id = ${item.parentExternalId}
        limit 1`;
      if (parent[0]?.content) item.context.parent_text = (parent[0].content as string).slice(0, 400);
    }
  }
}

export const discordAdapter: SourceAdapter = {
  source: "discord",

  async status(sql, ownerId) {
    if (fixtureMode()) return { configured: true, detail: "fixture mode" };
    const creds = await resolveCredentials(sql, ownerId, "discord_bot");
    return creds ? { configured: true } : { configured: false, detail: "DISCORD_BOT_TOKEN not configured" };
  },

  async testConnection(sql, ownerId) {
    const creds = await resolveCredentials(sql, ownerId, "discord_bot");
    if (!creds) return { ok: false, message: "no credentials" };
    try {
      const me = (await apiGet(creds, "/users/@me")) as { username?: string };
      return { ok: true, message: `bot connected as ${me.username ?? "?"}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  streams(_monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    return targets.filter((t) => t.kind === "guild").map((t) => ({ stream: `guild/${t.id}`, target: t }));
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor, cursorMeta } = ctx;
    if (fixtureMode()) {
      if (cursor || (cursorMeta as GuildMeta).channels) return { items: [], nextCursor: null };
      const msgs = await loadFixture<(ApiMessage & { guild_id?: string; channel_name?: string })[]>("discord");
      const items = msgs
        .map((m) => parseMessage(monitor.id, stream.stream, m.guild_id ?? "0", m.channel_name ?? "general", m))
        .filter((i): i is RawItem => i !== null && i.content.length > 0);
      const channels: Record<string, string> = {};
      for (const m of msgs) {
        const prev = channels[m.channel_id] ?? "0";
        if (BigInt(m.id) > BigInt(prev)) channels[m.channel_id] = m.id;
      }
      return { items, nextCursor: null, cursorMeta: { channels }, droppedCount: msgs.length - items.length };
    }

    const creds = await resolveCredentials(sql, monitor.owner_id, "discord_bot");
    if (!creds) return { items: [], nextCursor: null };

    const guildId = stream.target!.value;
    const meta = ctx.cursorMeta as GuildMeta;
    const channelCursors: Record<string, string> = { ...(meta.channels ?? {}) };
    const priorStrikes = meta.canary_strikes ?? 0;

    // Discover channels + active threads the bot can see.
    const channelList = (await apiGet(creds, `/guilds/${guildId}/channels`)) as {
      id: string;
      type: number;
      name?: string;
    }[];
    const threads = (await apiGet(creds, `/guilds/${guildId}/threads/active`)) as {
      threads?: { id: string; name?: string }[];
    };
    const all = [
      ...channelList.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name ?? "" })),
      ...(threads.threads ?? []).map((t) => ({ id: t.id, name: t.name ?? "" })),
    ];

    const items: RawItem[] = [];
    let dropped = 0;
    let nonBotSeen = 0;
    let nonBotWithContent = 0;
    const updatedCursors: Record<string, string> = { ...channelCursors };

    for (const channel of all) {
      // Per-channel forward-only first sync: no cursor -> start at now, fetch nothing.
      // (Legacy guild-wide cursor is honored as the starting point once.)
      const startCursor = channelCursors[channel.id] ?? cursor;
      if (!startCursor) {
        updatedCursors[channel.id] = datetimeToSnowflake(new Date());
        continue;
      }

      let after = startCursor;
      let lastProcessed = startCursor;
      let channelOk = true;

      for (let page = 0; page < PAGES_PER_CHANNEL; page++) {
        let batch: ApiMessage[];
        try {
          batch = (await apiGet(creds, `/channels/${channel.id}/messages`, {
            limit: "100",
            after,
          })) as ApiMessage[];
        } catch {
          // Per-channel failure: HOLD this channel's cursor (audit #3B) —
          // never let other channels' progress advance past it.
          channelOk = false;
          dropped++;
          break;
        }
        if (!Array.isArray(batch) || batch.length === 0) break;
        batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const m of batch) {
          if (!m.author?.bot) {
            nonBotSeen++;
            if ((m.content ?? "").length > 0) nonBotWithContent++;
          }
          const item = parseMessage(monitor.id, stream.stream, guildId, channel.name, m);
          if (item && item.content) items.push(item);
          lastProcessed = m.id;
        }
        after = batch[batch.length - 1]!.id;
        if (batch.length < 100) break;
        // Page cap hit with more remaining: lastProcessed is the CONTIGUOUS
        // high-water mark — the rest arrives next run (audit #3A).
      }

      if (channelOk) updatedCursors[channel.id] = lastProcessed;
    }

    // MESSAGE_CONTENT canary: non-bot messages flowed but ALL content empty.
    const suspicious = nonBotSeen >= 10 && nonBotWithContent === 0;
    if (suspicious) {
      const strikes = priorStrikes + 1;
      if (strikes >= 2 && !(await hasEventToday(sql, monitor.id, "canary_message_content"))) {
        await logEvent(sql, {
          monitorId: monitor.id,
          source: "discord",
          stream: stream.stream,
          level: "error",
          kind: "canary_message_content",
          message: `${nonBotSeen} non-bot messages fetched across ${strikes} consecutive runs, ALL with empty content — MESSAGE_CONTENT intent likely lost. Cursors held; nothing acknowledged as read.`,
        });
      }
      // HOLD everything: keep the pre-run channel cursors (audit #4a).
      return {
        items: [],
        nextCursor: null,
        cursorMeta: { channels: channelCursors, canary_strikes: strikes },
        droppedCount: dropped,
      };
    }

    await attachNeighbors(sql, monitor.id, items);
    return {
      items,
      nextCursor: null, // per-channel cursors live in cursorMeta
      cursorMeta: { channels: updatedCursors, canary_strikes: 0 },
      droppedCount: dropped,
    };
  },
};
