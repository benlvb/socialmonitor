import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMonitorConfig } from "@socialmonitor/shared";
import type { Db } from "@socialmonitor/db";
import type { MonitorRow } from "../src/db/repos";
import { xAdapter } from "../src/adapters/x";
import { redditAdapter } from "../src/adapters/reddit";
import { youtubeAdapter } from "../src/adapters/youtube";
import { telegramAdapter } from "../src/adapters/telegram";
import { discordAdapter, datetimeToSnowflake, snowflakeToDatetime } from "../src/adapters/discord";

const monitor: MonitorRow = {
  id: "00000000-0000-0000-0000-000000000001",
  owner_id: "00000000-0000-0000-0000-000000000002",
  name: "fixture-monitor",
  status: "active",
  config: parseMonitorConfig({}),
};

// Fixture mode never touches the DB — a null sql proves it.
const sql = null as unknown as Db;

beforeAll(() => {
  process.env.FIXTURE_MODE = "1";
});
afterAll(() => {
  delete process.env.FIXTURE_MODE;
});

describe("x adapter (fixtures)", () => {
  it("parses tweets into the RawItem contract", async () => {
    const r = await xAdapter.fetch({ sql, monitor, stream: { stream: "search/t1" }, cursor: null, cursorMeta: {} });
    expect(r.items.length).toBe(6);
    const first = r.items[0]!;
    expect(first.source).toBe("x");
    expect(first.externalId).toBe("1958100000000000001");
    expect(first.content).toContain("crashing");
    expect(first.authorFollowers).toBe(4200);
    expect(first.impressions).toBe(5400);
    expect(first.engagement).toBe(18 + 7 + 2 + 1);
    // Twitter's classic date format must parse (live API returns it too)
    expect(first.postedAt.getUTCFullYear()).toBe(2026);
    expect(Number.isNaN(first.postedAt.getTime())).toBe(false);
  });
  it("second run with a cursor is quiet", async () => {
    const r = await xAdapter.fetch({ sql, monitor, stream: { stream: "search/t1" }, cursor: "999", cursorMeta: {} });
    expect(r.items).toEqual([]);
  });
  it("reports configured in fixture mode", async () => {
    expect((await xAdapter.status(sql, monitor.owner_id)).configured).toBe(true);
  });
});

describe("reddit adapter (fixtures)", () => {
  it("parses posts and comments, no impressions (labeled proxy source)", async () => {
    const r = await redditAdapter.fetch({ sql, monitor, stream: { stream: "subreddit/t1" }, cursor: null, cursorMeta: {} });
    expect(r.items.length).toBe(3);
    const post = r.items.find((i) => i.externalId === "t3_1mxk2ab")!;
    expect(post.content).toContain("silently drops");
    expect(post.impressions).toBeNull();
    expect(post.engagement).toBe(87 + 23);
    expect(post.context.channel_name).toBe("r/analytics");
    const comment = r.items.find((i) => i.externalId === "t1_n8xyz01")!;
    expect(comment.context.parent_text).toContain("worth it");
  });
});

describe("youtube adapter (fixtures)", () => {
  it("parses videos (title + description as content)", async () => {
    const r = await youtubeAdapter.fetch({ sql, monitor, stream: { stream: "channel/t1" }, cursor: null, cursorMeta: {} });
    expect(r.items.length).toBe(2);
    expect(r.items[0]!.externalId).toBe("video:aBcD1234xyz");
    expect(r.items[0]!.content).toContain("honest review");
    expect(r.items[0]!.content).toContain("pricing jumped 40%");
  });
  it("parses comment threads with parent linkage", async () => {
    const r = await youtubeAdapter.fetch({ sql, monitor, stream: { stream: "comments" }, cursor: null, cursorMeta: {} });
    expect(r.items.length).toBe(2);
    expect(r.items[0]!.parentExternalId).toBe("video:aBcD1234xyz");
    expect(r.items[0]!.engagement).toBe(41);
  });
});

describe("telegram adapter (fixtures)", () => {
  it("parses channel posts with views as impressions", async () => {
    const r = await telegramAdapter.fetch({ sql, monitor, stream: { stream: "channel/t1" }, cursor: null, cursorMeta: {} });
    expect(r.items.length).toBe(2);
    expect(r.items[0]!.externalId).toBe("acmewidgetchat:4501");
    expect(r.items[0]!.impressions).toBe(1800);
    expect(r.nextCursor).toBe("4502");
  });
});

describe("discord adapter", () => {
  it("snowflake round-trips", () => {
    const d = new Date("2026-08-21T10:00:00.000Z");
    expect(snowflakeToDatetime(datetimeToSnowflake(d)).getTime()).toBe(d.getTime());
  });
  it("parses fixture messages, skips empty content", async () => {
    const r = await discordAdapter.fetch({ sql, monitor, stream: { stream: "guild/t1" }, cursor: null, cursorMeta: {} });
    expect(r.items.length).toBe(3);
    const reply = r.items.find((i) => i.externalId === "1408100000000000002")!;
    expect(reply.parentExternalId).toBe("1408100000000000001");
    expect(reply.context.channel_name).toBe("support");
    expect(r.items[0]!.impressions).toBeNull();
    // Per-channel cursors (audit #3): highest snowflake per channel
    const channels = (r.cursorMeta as { channels: Record<string, string> }).channels;
    expect(channels["990001"]).toBe("1408100000000000002");
    expect(channels["990002"]).toBe("1408100000000000003");
  });
});
