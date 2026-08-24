import { TransientError, errorFromStatus, type RawItem } from "@socialmonitor/shared";
import type { Db } from "@socialmonitor/db";
import type { MonitorRow, TargetRow } from "../db/repos";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { resolveCredentials, type Credentials } from "./credentials";
import { fixtureMode, loadFixture } from "./fixtures";
import { logEvent } from "../events";
import { getTargets } from "../db/repos";

/**
 * Discord adapter (D9): bot REST polling with snowflake cursors, forward-only
 * first sync, reply-chain + linear-neighbor context, and the MESSAGE_CONTENT
 * canary (HTTP 200 with empty content = silently dead bot — SPEC pitfalls).
 * Targets: kind=guild (value = guild id). Streams: one per text channel.
 */

const API = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n;

export function datetimeToSnowflake(d: Date): string {
  return (((BigInt(d.getTime()) - DISCORD_EPOCH) << 22n)).toString();
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

async function apiGet(creds: Credentials, pathname: string, params: Record<string, string> = {}): Promise<unknown> {
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
    // Reply-chain parent from DB if we have it.
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
    // One stream per guild; channels are expanded inside fetch (discovery is
    // dynamic — channels appear/disappear with bot permissions).
    return targets.filter((t) => t.kind === "guild").map((t) => ({ stream: `guild/${t.id}`, target: t }));
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
    if (fixtureMode()) {
      if (cursor) return { items: [], nextCursor: null };
      const msgs = await loadFixture<(ApiMessage & { guild_id?: string; channel_name?: string })[]>("discord");
      const items = msgs
        .map((m) => parseMessage(monitor.id, stream.stream, m.guild_id ?? "0", m.channel_name ?? "general", m))
        .filter((i): i is RawItem => i !== null && i.content.length > 0);
      const maxId = msgs.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), "0");
      return { items, nextCursor: maxId, droppedCount: msgs.length - items.length };
    }

    const creds = await resolveCredentials(sql, monitor.owner_id, "discord_bot");
    if (!creds) return { items: [], nextCursor: null };

    const guildId = stream.target!.value;

    // Forward-only first sync (SPEC section 5): no cursor -> start at now.
    if (!cursor) {
      return { items: [], nextCursor: datetimeToSnowflake(new Date()) };
    }

    // Discover channels + active threads the bot can see.
    const channels = (await apiGet(creds, `/guilds/${guildId}/channels`)) as {
      id: string;
      type: number;
      name?: string;
    }[];
    const threads = (await apiGet(creds, `/guilds/${guildId}/threads/active`)) as {
      threads?: { id: string; name?: string }[];
    };
    const all = [
      ...channels.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name ?? "" })),
      ...(threads.threads ?? []).map((t) => ({ id: t.id, name: t.name ?? "" })),
    ];

    const items: RawItem[] = [];
    let dropped = 0;
    let nonEmptySeen = 0;
    let totalSeen = 0;
    let maxId = BigInt(cursor);

    for (const channel of all) {
      let after = cursor;
      for (let page = 0; page < 3; page++) {
        let batch: ApiMessage[];
        try {
          batch = (await apiGet(creds, `/channels/${channel.id}/messages`, {
            limit: "100",
            after,
          })) as ApiMessage[];
        } catch (err) {
          // Missing access to one channel is per-channel, not guild-systemic.
          dropped++;
          break;
        }
        if (!Array.isArray(batch) || batch.length === 0) break;
        // With `after`, Discord returns ascending; normalize to ascending anyway.
        batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const m of batch) {
          totalSeen++;
          if ((m.content ?? "").length > 0) nonEmptySeen++;
          if (BigInt(m.id) > maxId) maxId = BigInt(m.id);
          const item = parseMessage(monitor.id, stream.stream, guildId, channel.name, m);
          if (item && item.content) items.push(item);
        }
        after = batch[batch.length - 1]!.id;
        if (batch.length < 100) break;
      }
    }

    // MESSAGE_CONTENT canary: messages flowed but every content was empty.
    if (totalSeen >= 10 && nonEmptySeen === 0) {
      await logEvent(sql, {
        monitorId: monitor.id,
        source: "discord",
        stream: stream.stream,
        level: "error",
        kind: "canary_message_content",
        message: `${totalSeen} messages fetched, ALL with empty content — MESSAGE_CONTENT intent likely lost. Bot is silently dead.`,
      });
    }

    await attachNeighbors(sql, monitor.id, items);
    return { items, nextCursor: maxId.toString(), droppedCount: dropped };
  },
};
