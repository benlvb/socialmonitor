import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMonitorConfig } from "@socialmonitor/shared";
import type { Db } from "@socialmonitor/db";
import type { MonitorRow } from "../src/db/repos";
import { xAdapter } from "../src/adapters/x";
import { redditAdapter } from "../src/adapters/reddit";
import { youtubeAdapter } from "../src/adapters/youtube";
import { telegramAdapter } from "../src/adapters/telegram";
import { discordAdapter, datetimeToSnowflake, snowflakeToDatetime } from "../src/adapters/discord";
import { appstoreAdapter, parseAppId, parseReview } from "../src/adapters/appstore";

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

describe("appstore adapter (fixtures)", () => {
  it("parses reviews: title + body, rating in context and metrics, votes as engagement", async () => {
    const r = await appstoreAdapter.fetch({ sql, monitor, stream: { stream: "reviews/us/t1" }, cursor: null, cursorMeta: {} });
    expect(r.items.length).toBe(5);
    const crash = r.items.find((i) => i.externalId === "14500000004")!;
    expect(crash.source).toBe("appstore");
    expect(crash.content.startsWith("Crashes on launch\n\n")).toBe(true);
    expect(crash.content).toContain("crashes every time");
    expect(crash.context.rating).toBe(1);
    expect(crash.context.app_version).toBe("4.2.0");
    expect(crash.context.channel_name).toBe("App Store (us)");
    expect(crash.metrics.rating).toBe(1);
    expect(crash.metrics.storefront).toBe("us");
    expect(crash.engagement).toBe(12);
    expect(crash.impressions).toBeNull();
    expect(crash.authorHandle).toBe("sarah_d");
    // -07:00 offset in the feed must land as UTC
    expect(crash.postedAt.toISOString()).toBe("2026-08-22T01:40:12.000Z");
    // title repeated as body is stored ONCE (review F5) — prefilter decides later
    expect(r.items.find((i) => i.externalId === "14500000002")!.content).toBe("👎");
    // cursor = newest `updated`
    expect(r.nextCursor).toBe("2026-08-22T16:15:00.000Z");
  });
  it("second run with a cursor is quiet", async () => {
    const r = await appstoreAdapter.fetch({ sql, monitor, stream: { stream: "reviews/us/t1" }, cursor: "2026-08-22T16:15:00.000Z", cursorMeta: {} });
    expect(r.items).toEqual([]);
  });
  it("is configured with no credentials at all, and testConnection makes no request", async () => {
    delete process.env.FIXTURE_MODE;
    try {
      expect((await appstoreAdapter.status(sql, monitor.owner_id)).configured).toBe(true);
      expect((await appstoreAdapter.testConnection(sql, monitor.owner_id)).ok).toBe(true);
    } finally {
      process.env.FIXTURE_MODE = "1";
    }
  });
  it("collapses a title repeated inside the body instead of doubling it (review F5)", () => {
    const entry = (title: string, body: string) => ({
      id: { label: "1" }, title: { label: title }, content: { label: body },
      updated: { label: "2026-08-20T13:30:00-07:00" }, author: { name: { label: "u" } },
      "im:rating": { label: "4" }, "im:version": { label: "1.0" }, "im:voteSum": { label: "0" }, "im:voteCount": { label: "0" },
    });
    const parse = (t: string, b: string) => parseReview(monitor.id, "reviews/us/t1", "us", "1", entry(t, b))!.content;
    expect(parse("BEST", "BEST APP")).toBe("BEST APP");
    expect(parse("Crashes on launch", "crashes on launch every time")).toBe("crashes on launch every time");
    expect(parse("Great app, one gripe", "Great")).toBe("Great app, one gripe");
    expect(parse("Widgets broke", "Since 4.2 the home screen widgets show stale numbers.")).toBe("Widgets broke\n\nSince 4.2 the home screen widgets show stale numbers.");
  });
  it("parseAppId accepts ids and App Store URLs", () => {
    expect(parseAppId("310633997")).toBe("310633997");
    expect(parseAppId(" https://apps.apple.com/us/app/whatsapp-messenger/id310633997?uo=4 ")).toBe("310633997");
    expect(parseAppId("https://apps.apple.com/gb/app/id310633997")).toBe("310633997");
    expect(parseAppId("acme widget")).toBeNull();
    expect(parseAppId("id12")).toBeNull();
  });
});
