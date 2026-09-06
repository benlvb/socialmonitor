import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemicError, TransientError, parseMonitorConfig } from "@socialmonitor/shared";
import { fakeSql, stubFetch } from "./helpers/fake-sql";
import type { MonitorRow, TargetRow } from "../src/db/repos";
import { xAdapter } from "../src/adapters/x";
import { redditAdapter } from "../src/adapters/reddit";
import { discordAdapter } from "../src/adapters/discord";
import { appstoreAdapter, lastPageOf } from "../src/adapters/appstore";
import { youtubeAdapter } from "../src/adapters/youtube";
import {
  buildJwt,
  parsePackageName,
  parseServiceAccount,
  playstoreAdapter,
  resetPlayTokenCache,
} from "../src/adapters/playstore";
import { createVerify, generateKeyPairSync } from "node:crypto";

/**
 * Adapter-level cursor semantics. Every case here corresponds to a real bug an
 * audit found: advancing past an incomplete page, one cursor for many Discord
 * channels, a canary that alerted while still acknowledging the data, and a
 * comment stream filtered by a global clock. Parse-output tests could not see
 * any of them.
 */

function monitorWith(overrides: Record<string, unknown> = {}): MonitorRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    owner_id: "00000000-0000-0000-0000-000000000002",
    name: "cursor-monitor",
    status: "active",
    config: parseMonitorConfig(overrides),
  };
}

const target = (over: Partial<TargetRow> = {}): TargetRow => ({
  id: "t1",
  monitor_id: "00000000-0000-0000-0000-000000000001",
  source: "x",
  kind: "keyword",
  value: "acme widget",
  enabled: true,
  config: {},
  ...over,
});

const tweet = (id: string, iso: string) => ({
  id,
  url: `https://x.com/u/status/${id}`,
  text: `tweet body ${id} with enough words to pass the prefilter`,
  createdAt: new Date(iso).toUTCString().replace("GMT", "+0000"),
  author: { id: "u1", userName: "u", name: "U", followers: 10 },
  likeCount: 1, replyCount: 0, retweetCount: 0, quoteCount: 0, viewCount: 5,
});

let restore: (() => void) | null = null;
/** pipeline_events inserts of one kind recorded by the fake sql. */
const eventsOfKind = (sql: ReturnType<typeof fakeSql>, kind: string) =>
  sql.calls.filter((c) => /insert into pipeline_events/.test(c.text) && c.values.includes(kind));
afterEach(() => {
  restore?.();
  restore = null;
  vi.unstubAllEnvs();
});

describe("X cursor semantics", () => {
  beforeEach(() => vi.stubEnv("TWITTERAPI_IO_KEY", "test-key"));

  it("forward-only first sync: records a position and fetches nothing", async () => {
    const s = stubFetch([]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await xAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "search/t1", target: target() },
      cursor: null, cursorMeta: {},
    });
    expect(r.items).toEqual([]);
    expect(Number(r.nextCursor)).toBeGreaterThan(1_700_000_000);
    expect(s.urls).toHaveLength(0); // no API call at all
  });

  it("a COMPLETE window advances the cursor to the newest item", async () => {
    const s = stubFetch([
      { match: /advanced_search/, response: { body: {
        tweets: [tweet("2", "2026-08-20T12:00:00Z"), tweet("1", "2026-08-20T11:00:00Z")],
        has_next_page: false,
      } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await xAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "search/t1", target: target() },
      cursor: "1000", cursorMeta: {},
    });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBe(String(Math.floor(Date.UTC(2026, 7, 20, 12) / 1000)));
    expect(r.cursorMeta).toEqual({ pending_until: null, pending_newest: null });
  });

  it("an INCOMPLETE window holds the cursor and remembers where to resume", async () => {
    const s = stubFetch([
      { match: /advanced_search/, response: { body: {
        tweets: [tweet("9", "2026-08-20T12:00:00Z"), tweet("8", "2026-08-20T11:00:00Z")],
        has_next_page: true, next_cursor: "PAGE2",
      } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await xAdapter.fetch({
      sql: sql.db,
      monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }),
      stream: { stream: "search/t1", target: target() },
      cursor: "1000", cursorMeta: {},
    });
    // The regression: this used to jump to the newest tweet, orphaning the gap.
    expect(r.nextCursor).toBeNull();
    expect(r.items).toHaveLength(2);
    const meta = r.cursorMeta as { pending_until: number; pending_newest: number };
    expect(meta.pending_until).toBe(Math.floor(Date.UTC(2026, 7, 20, 11) / 1000));
    expect(meta.pending_newest).toBe(Math.floor(Date.UTC(2026, 7, 20, 12) / 1000));
  });

  it("resuming a pending window queries until_time and restores the remembered newest", async () => {
    const pendingNewest = Math.floor(Date.UTC(2026, 7, 20, 12) / 1000);
    const s = stubFetch([
      { match: /advanced_search/, response: { body: {
        tweets: [tweet("7", "2026-08-20T10:30:00Z")],
        has_next_page: false,
      } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await xAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "search/t1", target: target() },
      cursor: "1000",
      cursorMeta: { pending_until: Math.floor(Date.UTC(2026, 7, 20, 11) / 1000), pending_newest: pendingNewest },
    });
    expect(decodeURIComponent(s.urls[0]!)).toContain("until_time:");
    // Window closed: jump to the newest we ever saw, not this page's newest.
    expect(r.nextCursor).toBe(String(pendingNewest));
    expect(r.cursorMeta).toEqual({ pending_until: null, pending_newest: null });
  });

  it("stopping on the read budget also holds the cursor", async () => {
    const s = stubFetch([]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await xAdapter.fetch({
      sql: sql.db,
      monitor: monitorWith({ budgets: { x_reads_per_day: 0 } }),
      stream: { stream: "search/t1", target: target() },
      cursor: "1000", cursorMeta: {},
    });
    expect(s.urls).toHaveLength(0);
    expect(r.nextCursor).toBeNull();
  });
});

describe("Reddit cursor semantics", () => {
  beforeEach(() => {
    vi.stubEnv("REDDIT_CLIENT_ID", "cid");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "sec");
    vi.stubEnv("REDDIT_USERNAME", "user");
    vi.stubEnv("REDDIT_PASSWORD", "pw");
  });

  const post = (id: string, createdSecs: number) => ({
    kind: "t3",
    data: {
      id, name: `t3_${id}`, title: `post ${id}`, selftext: "body text here",
      author: "someone", created_utc: createdSecs,
      permalink: `/r/x/comments/${id}/`, subreddit: "x", score: 1, num_comments: 0,
    },
  });
  const tokenStub = { match: /access_token/, response: { body: { access_token: "tok", expires_in: 3600 } } };

  it("forward-only first sync: no listing call, cursor recorded", async () => {
    const s = stubFetch([tokenStub]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await redditAdapter.fetch({
      sql: sql.db, monitor: monitorWith(),
      stream: { stream: "subreddit/t1", target: target({ source: "reddit", kind: "subreddit", value: "analytics" }) },
      cursor: null, cursorMeta: {},
    });
    expect(r.items).toEqual([]);
    expect(Number(r.nextCursor)).toBeGreaterThan(1_700_000_000);
  });

  it("walking back past the cursor completes the window and advances", async () => {
    const cursorSecs = 1_787_000_000;
    const s = stubFetch([
      tokenStub,
      { match: /r\/analytics\/new/, response: { body: { data: {
        children: [post("new1", cursorSecs + 100), post("old1", cursorSecs - 100)],
        after: "t3_old1",
      } } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await redditAdapter.fetch({
      sql: sql.db, monitor: monitorWith(),
      stream: { stream: "subreddit/t1", target: target({ source: "reddit", kind: "subreddit", value: "analytics" }) },
      cursor: String(cursorSecs), cursorMeta: {},
    });
    expect(r.items).toHaveLength(1); // only the item newer than the cursor
    expect(r.nextCursor).toBe(String(cursorSecs + 100));
  });

  it("hitting the page cap with pages remaining HOLDS the cursor", async () => {
    const cursorSecs = 1_787_000_000;
    const s = stubFetch([
      tokenStub,
      { match: /r\/analytics\/new/, response: { body: { data: {
        children: [post("a", cursorSecs + 300), post("b", cursorSecs + 200)],
        after: "t3_b",
      } } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await redditAdapter.fetch({
      sql: sql.db,
      monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }),
      stream: { stream: "subreddit/t1", target: target({ source: "reddit", kind: "subreddit", value: "analytics" }) },
      cursor: String(cursorSecs), cursorMeta: {},
    });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBeNull(); // never skip the unread remainder
  });
});

describe("Discord cursor semantics", () => {
  beforeEach(() => vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token"));

  const msg = (id: string, channelId: string, content = "a real message body", bot = false) => ({
    id, channel_id: channelId, content,
    author: { id: `u${id}`, username: `user${id}`, global_name: `User ${id}`, bot },
  });
  const guildTarget = target({ source: "discord", kind: "guild", value: "880001" });
  const chans = (...ids: string[]) => ({
    match: /guilds\/880001\/channels/,
    response: { body: ids.map((id) => ({ id, type: 0, name: `chan-${id}` })) },
  });
  const noThreads = { match: /threads\/active/, response: { body: { threads: [] } } };
  const base = "1408100000000000000";

  it("keeps a SEPARATE cursor per channel", async () => {
    const s = stubFetch([
      chans("990001", "990002"), noThreads,
      { match: /channels\/990001\/messages/, response: { body: [msg("1408100000000000005", "990001")] } },
      { match: /channels\/990002\/messages/, response: { body: [msg("1408100000000000009", "990002")] } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await discordAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "guild/t1", target: guildTarget },
      cursor: base, cursorMeta: { channels: { "990001": base, "990002": base } },
    });
    const channels = (r.cursorMeta as { channels: Record<string, string> }).channels;
    // The regression: one guild-wide max cursor let a quiet channel drag a busy
    // channel's position forward, skipping its messages permanently.
    expect(channels["990001"]).toBe("1408100000000000005");
    expect(channels["990002"]).toBe("1408100000000000009");
  });

  it("a failing channel holds ITS OWN cursor while others advance", async () => {
    const s = stubFetch([
      chans("990001", "990002"), noThreads,
      { match: /channels\/990001\/messages/, response: { status: 500, body: { message: "boom" } } },
      { match: /channels\/990002\/messages/, response: { body: [msg("1408100000000000009", "990002")] } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await discordAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "guild/t1", target: guildTarget },
      cursor: base, cursorMeta: { channels: { "990001": base, "990002": base } },
    });
    const channels = (r.cursorMeta as { channels: Record<string, string> }).channels;
    expect(channels["990001"]).toBe(base); // held
    expect(channels["990002"]).toBe("1408100000000000009"); // advanced
  });

  it("the MESSAGE_CONTENT canary holds EVERY cursor — nothing is acknowledged", async () => {
    const empties = Array.from({ length: 12 }, (_, i) =>
      msg(String(BigInt(base) + BigInt(i + 1)), "990001", ""),
    );
    const s = stubFetch([
      chans("990001"), noThreads,
      { match: /channels\/990001\/messages/, response: { body: empties } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await discordAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "guild/t1", target: guildTarget },
      cursor: base, cursorMeta: { channels: { "990001": base }, canary_strikes: 1 },
    });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
    const meta = r.cursorMeta as { channels: Record<string, string>; canary_strikes: number };
    expect(meta.channels["990001"]).toBe(base); // pre-run position, held
    expect(meta.canary_strikes).toBe(2);
  });

  it("bot-only traffic does NOT trip the canary", async () => {
    const bots = Array.from({ length: 12 }, (_, i) =>
      msg(String(BigInt(base) + BigInt(i + 1)), "990001", "", true),
    );
    const s = stubFetch([
      chans("990001"), noThreads,
      { match: /channels\/990001\/messages/, response: { body: bots } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await discordAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "guild/t1", target: guildTarget },
      cursor: base, cursorMeta: { channels: { "990001": base } },
    });
    const meta = r.cursorMeta as { channels: Record<string, string>; canary_strikes: number };
    expect(meta.canary_strikes).toBe(0);
    expect(meta.channels["990001"]).not.toBe(base); // normal advance
  });

  it("prunes cursors for channels that no longer exist", async () => {
    const s = stubFetch([
      chans("990001"), noThreads,
      { match: /channels\/990001\/messages/, response: { body: [] } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await discordAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "guild/t1", target: guildTarget },
      cursor: base, cursorMeta: { channels: { "990001": base, "999999": base } },
    });
    const channels = (r.cursorMeta as { channels: Record<string, string> }).channels;
    expect(Object.keys(channels)).toEqual(["990001"]);
  });

  it("a new thread starts at its own creation point, not 'now'", async () => {
    const threadId = "1408200000000000000";
    const s = stubFetch([
      chans(), // no text channels
      { match: /threads\/active/, response: { body: { threads: [{ id: threadId, name: "help" }] } } },
      { match: new RegExp(`channels/${threadId}/messages`), response: { body: [msg("1408200000000000005", threadId)] } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await discordAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "guild/t1", target: guildTarget },
      cursor: null, cursorMeta: { channels: {} },
    });
    // Fetched from (threadId - 1) rather than skipping the thread's opening messages.
    expect(decodeURIComponent(s.urls.at(-1)!)).toContain(`after=${(BigInt(threadId) - 1n).toString()}`);
    expect(r.items).toHaveLength(1);
  });
});

describe("App Store cursor semantics", () => {
  const CURSOR = "2026-08-20T12:00:00.000Z";
  const cursorMs = Date.parse(CURSOR);
  const iso = (offsetMin: number) => new Date(cursorMs + offsetMin * 60_000).toISOString();
  const review = (id: number, updated: string, rating = 1) => ({
    id: { label: String(id) },
    title: { label: `review ${id}` },
    content: { label: "the widget app crashes on launch after the latest update, twice today" },
    updated: { label: updated },
    author: { name: { label: `user${id}` }, uri: { label: `https://itunes.apple.com/us/reviews/id${id}` } },
    "im:rating": { label: String(rating) },
    "im:version": { label: "2.4.1" },
    "im:voteSum": { label: "0" },
    "im:voteCount": { label: "3" },
  });
  const feed = (entries: unknown[]) => ({ feed: { entry: entries } });
  /** A healthy Apple page carries first/previous/next/last links. */
  const linked = (entries: unknown[], page: number, last: number) => ({
    feed: {
      entry: entries,
      link: ["first", "previous", "next", "last"].map((rel) => ({
        attributes: { rel, href: `https://itunes.apple.com/us/rss/customerreviews/page=${rel === "last" ? last : rel === "next" ? Math.min(page + 1, last) : rel === "previous" ? Math.max(page - 1, 1) : 1}/id=310633997/sortBy=mostRecent/json` },
      })),
    },
  });
  /** A full 50-entry page, newest-first, all newer than the cursor. */
  const fullPage = (page: number) =>
    feed(Array.from({ length: 50 }, (_, k) => review(100_000 - page * 100 - k, iso(10_000 - page * 100 - k))));
  const appTarget = target({ source: "appstore", kind: "app", value: "310633997" });
  const streamDef = { stream: "reviews/us/t1", target: appTarget };

  it("forward-only first sync: records now, fetches nothing", async () => {
    const s = stubFetch([]);
    restore = s.restore;
    const r = await appstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: null, cursorMeta: {},
    });
    expect(r.items).toEqual([]);
    expect(Date.parse(r.nextCursor!)).toBeGreaterThan(Date.now() - 60_000);
    expect(s.urls).toHaveLength(0);
  });

  it("walking back to the cursor covers the window: newer items stored, cursor advances", async () => {
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: feed([review(3, iso(120)), review(2, iso(60)), review(1, iso(-60))]) } },
    ]);
    restore = s.restore;
    const r = await appstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items.map((i) => i.externalId)).toEqual(["3", "2"]);
    expect(r.nextCursor).toBe(iso(120));
    expect(s.urls).toHaveLength(1);
    expect(s.urls[0]).toContain("/us/rss/customerreviews/id=310633997/sortBy=mostRecent/page=1/json");
  });

  it("max_pages_per_fetch does not apply: the walk runs to completion inside Apple's cap", async () => {
    // A smaller cap could never converge on a busy backfill (review S2): two
    // runs would return the same 50 with the cursor held, forever.
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: fullPage(1) } },
      { match: /page=2\/json/, response: { body: feed([review(7, iso(5)), review(1, iso(-60))]) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }),
      stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(51);
    expect(r.nextCursor).toBe(iso(10_000 - 100));
    expect(s.urls).toHaveLength(2);
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("a NEW review in the cursor's own second is kept, not skipped as covered", async () => {
    // `updated` is second-granular: review 4 lands at exactly the cursor set by
    // review 3 one run earlier. `<=` lost it permanently (review F1).
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: feed([review(4, CURSOR), review(1, iso(-60))]) } },
    ]);
    restore = s.restore;
    const r = await appstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items.map((i) => i.externalId)).toEqual(["4"]);
    expect(r.nextCursor).toBe(CURSOR);
  });

  it("a short page with no usable `last` HOLDS: the end is unconfirmable, so the pages behind it are not skipped", async () => {
    // Apple always ships `last` alongside entries (100 live shapes, plus
    // Broadcasts p3 = 34 entries/last=3), so a short link-less page is a
    // truncated response, not an exhausted feed. Advancing here would drop
    // pages 3+ permanently once the 500-review window slides.
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: fullPage(1) } },
      { match: /page=2\/json/, response: { body: feed([review(7, iso(5)), review(6, iso(4))]) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 5 } }),
      stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(52);
    expect(r.nextCursor).toBeNull();
    expect(s.urls).toHaveLength(2);
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(1);
    expect(eventsOfKind(sql, "coverage_lost")).toHaveLength(0);
  });

  it("a short page AT the feed's own `last` is a clean end: cursor advances", async () => {
    // The real exhaustion shape, measured live: the final page is short and
    // still carries `last` equal to itself, so the walk ends at the
    // `page >= lastPage` check without ever reaching the anomaly branch.
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: linked(fullPage(1).feed.entry, 1, 2) } },
      { match: /page=2\/json/, response: { body: linked([review(7, iso(5)), review(6, iso(4))], 2, 2) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 5 } }),
      stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(52);
    expect(r.nextCursor).toBe(iso(10_000 - 100));
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("Apple's 10-page cap is lossy-but-covered: cursor ADVANCES with a coverage_lost error", async () => {
    // Real feeds with 500+ reviews report last=10 on every page — the cap
    // itself — so the `last` break must not strand the cap flag (round 3 N1).
    const s = stubFetch(
      Array.from({ length: 10 }, (_, k) => ({
        match: new RegExp(`page=${k + 1}/json`), response: { body: linked(fullPage(k + 1).feed.entry, k + 1, 10) },
      })),
    );
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 10 } }),
      stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(500);
    // Holding here would re-walk 10 pages every tick forever and never advance.
    expect(r.nextCursor).toBe(iso(10_000 - 100));
    expect(s.urls).toHaveLength(10);
    expect(s.urls.some((u) => /page=11\//.test(u))).toBe(false);
    const lost = eventsOfKind(sql, "coverage_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.values).toContain("error");
    expect(String(lost[0]!.values.find((v) => typeof v === "string" && /unreachable/.test(v)))).toContain("500");
    // Debounced per STREAM, not per monitor: another storefront or source's
    // advisory gap must not silence a loss on this one (review F2).
    const debounce = sql.calls.find((c) => /from pipeline_events/.test(c.text) && c.values.includes("coverage_lost"));
    expect(debounce?.values).toContain("reviews/us/t1");
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("Apple's cap with every entry unparseable HOLDS and does not claim an advance", async () => {
    const broken = (page: number) => feed(Array.from({ length: 50 }, (_, k) => ({ id: { label: String(page * 100 + k) }, title: { label: "no updated field" } })));
    const s = stubFetch(
      Array.from({ length: 10 }, (_, k) => ({ match: new RegExp(`page=${k + 1}/json`), response: { body: linked(broken(k + 1).feed.entry, k + 1, 10) } })),
    );
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(0);
    expect(r.nextCursor).toBeNull();
    expect(r.droppedCount).toBe(500);
    expect(eventsOfKind(sql, "coverage_lost")).toHaveLength(0); // review F3: no "cursor advanced" while holding
  });

  it("a 400 past page 1 is ambiguous (feed end vs hiccup): transient, cursor held", async () => {
    // Advancing here could skip reviews Apple failed to serve (review S6).
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: fullPage(1) } },
      { match: /page=2\/json/, response: { status: 400, body: "" } },
    ]);
    restore = s.restore;
    await expect(
      appstoreAdapter.fetch({
        sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
      }),
    ).rejects.toThrow(TransientError);
    expect(s.urls).toHaveLength(2);
  });

  it("a 400 on page 1 is a bad storefront or app: systemic (breaker), cursor untouched", async () => {
    const s = stubFetch([{ match: /page=1\/json/, response: { status: 400, body: "" } }]);
    restore = s.restore;
    await expect(
      appstoreAdapter.fetch({
        sql: fakeSql().db, monitor: monitorWith(),
        stream: { stream: "reviews/zz/t1", target: appTarget }, cursor: CURSOR, cursorMeta: {},
      }),
    ).rejects.toThrow(SystemicError);
  });

  it("an edited review (id already stored) is dropped, but the cursor still moves past it", async () => {
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: feed([review(9, iso(120)), review(8, iso(60)), review(1, iso(-60))]) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    sql.when(/from raw_items/, [{ external_id: "9" }]);
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items.map((i) => i.externalId)).toEqual(["8"]);
    expect(r.nextCursor).toBe(iso(120));
    expect(r.droppedCount).toBeUndefined(); // an edit is not a parse failure
    // Scoped to this stream so the query matches the edit case exactly
    // (review S1; ids are disjoint across storefronts in practice).
    const dedupe = sql.calls.find((c) => /from raw_items/.test(c.text));
    expect(dedupe?.text).toContain("stream = ?");
    expect(dedupe?.values).toContain("reviews/us/t1");
  });

  it("a transient EMPTY page mid-feed (no links) holds the cursor and warns instead of skipping pages", async () => {
    // Probed live: 4 of 30 app×storefront pairs served an empty page between
    // two full ones (review N1). Advancing here orphaned pages 4..10.
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: linked(fullPage(1).feed.entry, 1, 10) } },
      { match: /page=2\/json/, response: { body: linked(fullPage(2).feed.entry, 2, 10) } },
      { match: /page=3\/json/, response: { body: { feed: {} } } },
      { match: /page=4\/json/, response: { body: linked(fullPage(4).feed.entry, 4, 10) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(100); // pages 1-2 still stored
    expect(r.nextCursor).toBeNull(); // held: page 3's reviews are not skipped
    expect(s.urls).toHaveLength(3); // page 4 not requested — the walk is contiguous or nothing
    const gaps = eventsOfKind(sql, "coverage_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.values).toContain("warn");
  });

  it("a short page BELOW the feed's own `last` is an anomaly: hold + warn", async () => {
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: linked(fullPage(1).feed.entry, 1, 3) } },
      { match: /page=2\/json/, response: { body: linked([review(7, iso(5))], 2, 3) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(51);
    expect(r.nextCursor).toBeNull();
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(1);
  });

  it("the feed's `last` link ends the walk: a full page 1 with last=1 advances without asking for page 2", async () => {
    const s = stubFetch([{ match: /page=1\/json/, response: { body: linked(fullPage(1).feed.entry, 1, 1) } }]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(50);
    expect(r.nextCursor).toBe(iso(10_000 - 100));
    expect(s.urls).toHaveLength(1);
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("an empty page PAST `last` is the genuine end (small apps): advance, no warning", async () => {
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: linked(fullPage(1).feed.entry, 1, 2) } },
      { match: /page=2\/json/, response: { body: linked([], 3, 1) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(50);
    expect(r.nextCursor).toBe(iso(10_000 - 100));
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("an empty page 1 with no links (unserved storefront or a blip) holds quietly", async () => {
    const s = stubFetch([{ match: /page=1\/json/, response: { body: { feed: {} } } }]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("a SHORT page 10 with last=10 is a clean end, not the cap: advance, no coverage_lost", async () => {
    const s = stubFetch([
      ...Array.from({ length: 9 }, (_, k) => ({ match: new RegExp(`page=${k + 1}/json`), response: { body: linked(fullPage(k + 1).feed.entry, k + 1, 10) } })),
      { match: /page=10\/json/, response: { body: linked([review(5, iso(3)), review(4, iso(2))], 10, 10) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(452);
    expect(r.nextCursor).toBe(iso(10_000 - 100));
    expect(eventsOfKind(sql, "coverage_lost")).toHaveLength(0);
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("the anomaly (hold) path still drops already-stored ids — it re-walks every tick, so it meets edits most", async () => {
    const page1 = fullPage(1).feed.entry as { id: { label: string } }[];
    const storedId = page1[0]!.id.label;
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: linked(page1, 1, 10) } },
      { match: /page=2\/json/, response: { body: { feed: {} } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    sql.when(/from raw_items/, [{ external_id: storedId }]);
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    expect(r.items).toHaveLength(49); // round 3 N2: the early return skipped the dedupe
    expect(r.items.some((i) => i.externalId === storedId)).toBe(false);
  });

  it("an empty page 1 WITH links claiming more pages is a blank, not an unserved storefront: hold + warn", async () => {
    const s = stubFetch([{ match: /page=1\/json/, response: { body: linked([], 1, 10) } }]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(1);
  });

  it("lastPageOf reads the path segment of Apple's real href, which carries page= twice", () => {
    const href = "https://itunes.apple.com/us/rss/customerreviews/page=10/id=310633997/sortby=mostrecent/xml?urlDesc=/customerreviews/id=310633997/sortBy=mostRecent/page=2/json";
    expect(lastPageOf({ feed: { link: [{ attributes: { rel: "last", href } }] } })).toBe(10);
    expect(lastPageOf({ feed: { link: { attributes: { rel: "last", href: "https://x/page=3/json" } } } })).toBe(3);
    expect(lastPageOf({ feed: { link: [{ attributes: { rel: "last", href: "https://x/page=0/json" } }] } })).toBeNull();
    expect(lastPageOf({ feed: { link: [{ attributes: { rel: "next", href: "https://x/page=2/json" } }] } })).toBeNull();
    expect(lastPageOf({ feed: {} })).toBeNull();
    expect(lastPageOf({})).toBeNull();
    // A malformed element must not throw: the runner would read it as systemic.
    expect(lastPageOf({ feed: { link: [null as unknown as { attributes?: { rel?: string; href?: string } }] } })).toBeNull();
  });

  it("an unserved storefront (live shape: five links with EMPTY hrefs, no entries) holds quietly", async () => {
    // Verbatim shape from storefronts Apple does not serve (probed li/ad/la):
    // links are present but carry no page number, so `last` is unusable.
    const unserved = {
      feed: {
        link: ["alternate", "self", "first", "last", "previous", "next"].map((rel) => ({ attributes: { rel, href: "" } })),
      },
    };
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: unserved } },
      { match: /lookup\?id=\d+&country=li/, response: { body: { resultCount: 0 } } },
      // The app is real, just absent here: a storefront this monitor reads has it.
      { match: /lookup\?id=\d+&country=us/, response: { body: { resultCount: 1 } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: { stream: "reviews/li/t1", target: appTarget }, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0); // not a daily warning per dead storefront
    // Recorded rather than silent, but at info: a configured storefront Apple
    // does not serve is a settled state, not something to page on.
    const dead = eventsOfKind(sql, "target_unavailable");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.values).toContain("info");
    expect(s.urls).toHaveLength(3); // feed, lookup(li), lookup(us)
  });

  it("an app Apple sells only OUTSIDE this storefront is info, never a false 'wrong id' error", async () => {
    // The regression that shipped in the first cut of this fix: an UNSCOPED
    // lookup is the `us` storefront under another name (93 of 310 real apps
    // answer 0 unscoped), so treating an unscoped 0 as "no such id" paged a
    // daily error on, say, a China-only app with a million live reviews. The
    // id question may only be answered by sweeping the configured storefronts.
    const empty = {
      feed: { link: ["self", "first", "last"].map((rel) => ({ attributes: { rel, href: "" } })) },
    };
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: empty } },
      { match: /lookup\?id=\d+&country=us/, response: { body: { resultCount: 0 } } },
      { match: /lookup\?id=\d+&country=cn/, response: { body: { resultCount: 1 } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db,
      monitor: monitorWith({ limits: { appstore_storefronts: ["us", "cn"] } }),
      stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    const ev = eventsOfKind(sql, "target_unavailable");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.values).toContain("info"); // NOT error — the id is fine
    expect(ev[0]!.values).not.toContain("error");
    expect(String(ev[0]!.values.find((v) => typeof v === "string" && /storefront/.test(v)))).toContain("cn");
  });

  it("a nonexistent app id is an ERROR: it resolves in none of the monitor's storefronts", async () => {
    // Apple answers 200 with zero entries for a bad id exactly as it does for an
    // unserved storefront, so the feed alone cannot separate them and the stream
    // used to hold forever saying nothing. Only a per-storefront sweep can.
    const empty = {
      feed: { link: ["self", "first", "last"].map((rel) => ({ attributes: { rel, href: "" } })) },
    };
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: empty } },
      { match: /lookup\?id=\d+&country=us/, response: { body: { resultCount: 0 } } },
      { match: /lookup\?id=\d+&country=cn/, response: { body: { resultCount: 0 } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db,
      monitor: monitorWith({ limits: { appstore_storefronts: ["us", "cn"] } }),
      stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull(); // still holds — never advance over an unknown
    const bad = eventsOfKind(sql, "target_unavailable");
    expect(bad).toHaveLength(1);
    expect(bad[0]!.values).toContain("error");
    expect(String(bad[0]!.values.find((v) => typeof v === "string" && /resolves in none/.test(v)))).toContain("310633997");
    expect(s.urls).toHaveLength(3); // feed, lookup(us), lookup(cn)
  });

  it("an app served here with no reviews yet is info, and says so accurately", async () => {
    const empty = {
      feed: { link: ["self", "first", "last"].map((rel) => ({ attributes: { rel, href: "" } })) },
    };
    const s = stubFetch([
      { match: /page=1\/json/, response: { body: empty } },
      { match: /lookup\?id=\d+&country=us/, response: { body: { resultCount: 1 } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    const ev = eventsOfKind(sql, "target_unavailable");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.values).toContain("info");
    expect(String(ev[0]!.values.find((v) => typeof v === "string" && /no reviews/.test(v)))).toContain("us");
    expect(s.urls).toHaveLength(2); // no sweep needed — this storefront has it
  });

  it("an empty page 1 whose lookup is unreachable records the ambiguity instead of going quiet", async () => {
    const empty = { feed: { link: [{ attributes: { rel: "last", href: "" } }] } };
    // The lookup is deliberately unstubbed — stubFetch throws, which is the
    // network-failure path.
    const s = stubFetch([{ match: /page=1\/json/, response: { body: empty } }]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    const unknown = eventsOfKind(sql, "target_unavailable");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.values).toContain("info");
    expect(
      String(unknown[0]!.values.find((v) => typeof v === "string" && /could not be reached/.test(v))),
    ).toContain("unconfirmed");
  });

  it("a page 10 with MORE than 50 entries still counts as the cap (>= guard)", async () => {
    const s = stubFetch([
      ...Array.from({ length: 9 }, (_, k) => ({ match: new RegExp(`page=${k + 1}/json`), response: { body: linked(fullPage(k + 1).feed.entry, k + 1, 10) } })),
      { match: /page=10\/json/, response: { body: linked([...(fullPage(10).feed.entry as unknown[]), review(1, iso(1))], 10, 10) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await appstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(501);
    expect(eventsOfKind(sql, "coverage_lost")).toHaveLength(1);
  });

  it("expands one app target into one stream per configured storefront, uuid last", () => {
    const streams = appstoreAdapter.streams(
      monitorWith({ limits: { appstore_storefronts: ["us", "gb"] } }),
      [appTarget, target({ id: "t2", source: "appstore", kind: "keyword", value: "ignored" })],
    );
    expect(streams.map((s) => s.stream)).toEqual(["reviews/us/t1", "reviews/gb/t1"]);
  });

  it("a target that is not an app id fails systemically instead of fetching", async () => {
    const s = stubFetch([]);
    restore = s.restore;
    await expect(
      appstoreAdapter.fetch({
        sql: fakeSql().db, monitor: monitorWith(),
        stream: { stream: "reviews/us/t1", target: target({ source: "appstore", kind: "app", value: "acme widget" }) },
        cursor: CURSOR, cursorMeta: {},
      }),
    ).rejects.toThrow(SystemicError);
    expect(s.urls).toHaveLength(0);
  });
});

describe("coverage_gap debounce is scoped per stream (review of PR #2)", () => {
  // The debounce query is `select 1 from pipeline_events where kind = ? … (?::text is null or stream = ?)`.
  // Unscoped (stream = null) it matches ANY coverage_gap for the monitor that day, so an
  // App Store blank page at 08:00 silenced X/Reddit/YouTube's own warnings until midnight.
  function debounceQuery(sql: ReturnType<typeof fakeSql>) {
    const q = sql.calls.find((c) => /from pipeline_events where kind = \?/.test(c.text));
    expect(q, "the adapter consulted the coverage_gap debounce").toBeDefined();
    expect(q!.values[0]).toBe("coverage_gap");
    return q!.values;
  }

  it("X holds an incomplete window and debounces on ITS stream, not the monitor", async () => {
    vi.stubEnv("TWITTERAPI_IO_KEY", "test-key");
    const s = stubFetch([
      { match: /advanced_search/, response: { body: {
        tweets: [tweet("9", "2026-08-20T12:00:00Z"), tweet("8", "2026-08-20T11:00:00Z")],
        has_next_page: true, next_cursor: "PAGE2",
      } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await xAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }),
      stream: { stream: "search/t1", target: target() }, cursor: "1000", cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    const values = debounceQuery(sql);
    expect(values[3]).toBe("search/t1");
    expect(values[4]).toBe("search/t1");
  });

  it("Reddit's page-cap hold debounces on its stream", async () => {
    vi.stubEnv("REDDIT_CLIENT_ID", "cid");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "sec");
    vi.stubEnv("REDDIT_USERNAME", "user");
    vi.stubEnv("REDDIT_PASSWORD", "pw");
    const cursorSecs = 1_787_000_000;
    const post = (id: string, createdSecs: number) => ({
      kind: "t3",
      data: { id, name: `t3_${id}`, title: `post ${id}`, selftext: "body text here", author: "someone",
        created_utc: createdSecs, permalink: `/r/x/comments/${id}/`, subreddit: "x", score: 1, num_comments: 0 },
    });
    const s = stubFetch([
      { match: /access_token/, response: { body: { access_token: "tok", expires_in: 3600 } } },
      { match: /r\/analytics\/new/, response: { body: { data: {
        children: [post("a", cursorSecs + 300), post("b", cursorSecs + 200)], after: "t3_b",
      } } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await redditAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }),
      stream: { stream: "subreddit/t1", target: target({ source: "reddit", kind: "subreddit", value: "analytics" }) },
      cursor: String(cursorSecs), cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    expect(debounceQuery(sql)[3]).toBe("subreddit/t1");
  });

  const video = (id: string, iso: string) => ({
    id: { videoId: id },
    snippet: { publishedAt: iso, title: `video ${id}`, description: "a description", channelTitle: "c", channelId: "UC1",
      resourceId: { videoId: id } },
  });

  it("YouTube's channel (uploads) page-cap hold debounces on its stream", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "yt-key");
    const s = stubFetch([
      { match: /\/channels\?/, response: { body: { items: [{ contentDetails: { relatedPlaylists: { uploads: "UUabc" } } }] } } },
      { match: /\/playlistItems\?/, response: { body: { items: [video("v1", "2026-08-21T00:00:00Z")], nextPageToken: "P2" } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await youtubeAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }),
      stream: { stream: "channel/t1", target: target({ source: "youtube", kind: "channel", value: "UCabc" }) },
      cursor: "2026-08-20T00:00:00.000Z", cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    expect(debounceQuery(sql)[3]).toBe("channel/t1");
  });

  it("YouTube's keyword-search remainder debounces on its stream", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "yt-key");
    const s = stubFetch([
      { match: /\/search\?/, response: { body: { items: [video("v2", "2026-08-21T00:00:00Z")], nextPageToken: "P2" } } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await youtubeAdapter.fetch({
      sql: sql.db, monitor: monitorWith(),
      stream: { stream: "search/t1", target: target({ source: "youtube", kind: "keyword", value: "acme" }) },
      cursor: "2026-08-20T00:00:00.000Z", cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    expect((r.cursorMeta as { pending_until: string }).pending_until).toBe("2026-08-21T00:00:00.000Z");
    expect(debounceQuery(sql)[3]).toBe("search/t1");
  });
});

describe("Google Play cursor semantics", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const EMAIL = "svc@proj.iam.gserviceaccount.com";
  const SA = JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: privateKey, token_uri: "https://oauth2.googleapis.com/token" });
  const tokenStub = { match: /oauth2\.googleapis\.com\/token/, response: { body: { access_token: "tok", expires_in: 3600 } } };
  const PKG = "com.acme.app";
  const CURSOR = "2026-08-20T00:00:00.000Z";
  const cursorSecs = Math.floor(Date.parse(CURSOR) / 1000);
  const iso = (secs: number) => new Date(secs * 1000).toISOString();
  const review = (id: string, seconds: number, extra: Record<string, unknown> = {}, text = `review ${id} with enough words to pass the prefilter`) => ({
    reviewId: id,
    authorName: `author ${id}`,
    comments: [{ userComment: { text, lastModified: { seconds: String(seconds), nanos: 0 }, starRating: 4, reviewerLanguage: "en", appVersionName: "4.2.0", thumbsUpCount: 3, ...extra } }],
  });
  const page = (reviews: unknown[], nextPageToken?: string) => ({ reviews, ...(nextPageToken ? { tokenPagination: { nextPageToken } } : {}) });
  const PAGE1 = /reviews\?maxResults=100$/;
  const pageWith = (tok: string) => new RegExp(`reviews\\?maxResults=100&token=${tok}$`);
  const streamDef = { stream: "reviews/t1", target: target({ source: "playstore", kind: "app", value: PKG }) };
  const debounce = (sql: ReturnType<typeof fakeSql>) => sql.calls.find((c) => /from pipeline_events where kind = \?/.test(c.text));

  beforeEach(() => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", SA);
    resetPlayTokenCache();
  });

  it("forward-only first sync: records now and makes no network call at all", async () => {
    const s = stubFetch([]);
    restore = s.restore;
    const before = Date.now();
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: null, cursorMeta: {} });
    expect(r.items).toEqual([]);
    expect(Date.parse(r.nextCursor!)).toBeGreaterThanOrEqual(before - 1000);
    expect(s.urls).toEqual([]);
  });

  it("no service account is a state, not an error: status unconfigured, fetch skips silently", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "");
    const s = stubFetch([]);
    restore = s.restore;
    const sql = fakeSql();
    expect((await playstoreAdapter.status(sql.db, "owner")).configured).toBe(false);
    const r = await playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r).toEqual({ items: [], nextCursor: null });
    expect(s.urls).toEqual([]);
  });

  it("a present-but-malformed key file is systemic (breaker), never silent", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({ client_email: EMAIL }));
    const s = stubFetch([]);
    restore = s.restore;
    const sql = fakeSql();
    const status = await playstoreAdapter.status(sql.db, "owner");
    expect(status.configured).toBe(true);
    expect(status.detail).toMatch(/not a service-account key/);
    await expect(
      playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
    ).rejects.toBeInstanceOf(SystemicError);
    expect(s.urls).toEqual([]);
    expect(parseServiceAccount("not json")).toBeNull();
    expect(parseServiceAccount(SA)?.client_email).toBe(EMAIL);
  });

  it("walking back to the cursor covers the window: newer items stored, cursor = newest lastModified, meta cleared", async () => {
    const s = stubFetch([
      tokenStub,
      { match: PAGE1, response: { body: page([review("a", cursorSecs + 300), review("b", cursorSecs + 200), review("old", cursorSecs - 1)], "P2") } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items.map((i) => i.externalId)).toEqual(["a", "b"]);
    expect(r.nextCursor).toBe(iso(cursorSecs + 300));
    expect(r.cursorMeta).toEqual({ pending_token: null, pending_newest: null });
    expect(s.urls.filter((u) => /reviews/.test(u))).toHaveLength(1); // page 2 never requested
    expect(s.urls[1]).toContain(`/applications/${PKG}/reviews`);
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("a review in the cursor's own second is kept, not skipped as covered (strict <)", async () => {
    const s = stubFetch([tokenStub, { match: PAGE1, response: { body: page([review("same", cursorSecs), review("old", cursorSecs - 5)]) } }]);
    restore = s.restore;
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items.map((i) => i.externalId)).toEqual(["same"]);
  });

  it("page budget exhausted with pages remaining: HOLD, remember Google's token and the newest seen, warn once per stream", async () => {
    const s = stubFetch([
      tokenStub,
      { match: PAGE1, response: { body: page([review("a", cursorSecs + 300), review("b", cursorSecs + 200)], "P2") } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(2); // stored
    expect(r.nextCursor).toBeNull(); // held: page 2 may hold reviews newer than the cursor
    expect(r.cursorMeta).toEqual({ pending_token: "P2", pending_newest: iso(cursorSecs + 300) });
    const gaps = eventsOfKind(sql, "coverage_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.values).toContain("warn");
    expect(debounce(sql)!.values[3]).toBe("reviews/t1"); // scoped to this stream
  });

  it("resumes from the remembered token, then advances to the remembered newest once the walk completes", async () => {
    const s = stubFetch([
      tokenStub,
      { match: pageWith("P2"), response: { body: page([review("c", cursorSecs + 100), review("old", cursorSecs - 100)], "P3") } },
    ]);
    restore = s.restore;
    const r = await playstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR,
      cursorMeta: { pending_token: "P2", pending_newest: iso(cursorSecs + 300) },
    });
    expect(s.urls.filter((u) => /reviews/.test(u))).toEqual([expect.stringMatching(/token=P2$/)]); // no page 1
    expect(r.items.map((i) => i.externalId)).toEqual(["c"]);
    expect(r.nextCursor).toBe(iso(cursorSecs + 300)); // the newest from the FIRST run, not c
    expect(r.cursorMeta).toEqual({ pending_token: null, pending_newest: null });
  });

  it("a rejected (stale) resume token restarts the walk from page 1 instead of throwing", async () => {
    const s = stubFetch([
      tokenStub,
      { match: pageWith("STALE"), response: { status: 400, body: { error: { code: 400, message: "Invalid page token" } } } },
      { match: PAGE1, response: { body: page([review("a", cursorSecs + 300), review("old", cursorSecs - 10)]) } },
    ]);
    restore = s.restore;
    const r = await playstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR,
      cursorMeta: { pending_token: "STALE", pending_newest: null },
    });
    expect(s.urls.filter((u) => /reviews/.test(u)).map((u) => u.split("?")[1])).toEqual(["maxResults=100&token=STALE", "maxResults=100"]);
    expect(r.items.map((i) => i.externalId)).toEqual(["a"]);
    expect(r.nextCursor).toBe(iso(cursorSecs + 300));
  });

  it("an EMPTY page that still carries a nextPageToken is not the end: the walk follows the token", async () => {
    // proto3 JSON omits an empty `reviews`; treating that as end-of-list advanced the
    // cursor over every later page (review of PR #3).
    const s = stubFetch([
      tokenStub,
      { match: PAGE1, response: { body: page([review("a", cursorSecs + 300), review("b", cursorSecs + 200)], "P2") } },
      { match: pageWith("P2"), response: { body: { tokenPagination: { nextPageToken: "P3" } } } },
      { match: pageWith("P3"), response: { body: page([review("c", cursorSecs + 100), review("old", cursorSecs - 1)]) } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(s.urls.filter((u) => /reviews/.test(u))).toHaveLength(3);
    expect(r.items.map((i) => i.externalId)).toEqual(["a", "b", "c"]);
    expect(r.nextCursor).toBe(iso(cursorSecs + 300));
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("an empty page with a token at the budget edge HOLDS with that token — never a covered window", async () => {
    const s = stubFetch([
      tokenStub,
      { match: PAGE1, response: { body: page([review("a", cursorSecs + 300)], "P2") } },
      { match: pageWith("P2"), response: { body: { tokenPagination: { nextPageToken: "P3" } } } },
    ]);
    restore = s.restore;
    const r = await playstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith({ limits: { max_pages_per_fetch: 2 } }), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.nextCursor).toBeNull();
    expect(r.cursorMeta).toEqual({ pending_token: "P3", pending_newest: iso(cursorSecs + 300) });
    // the resume path meets the same shape: still not the end
    const s2 = stubFetch([
      { match: pageWith("P3"), response: { body: { tokenPagination: { nextPageToken: "P4" } } } },
      { match: pageWith("P4"), response: { body: page([review("old", cursorSecs - 1)]) } },
    ]);
    restore = () => { s.restore(); s2.restore(); };
    const r2 = await playstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: r.cursorMeta ?? {},
    });
    expect(r2.nextCursor).toBe(iso(cursorSecs + 300));
    expect(r2.cursorMeta).toEqual({ pending_token: null, pending_newest: null });
  });

  it("an empty page WITHOUT a token is the genuine end: nothing newer, cursor held, meta cleared, no warning", async () => {
    const s = stubFetch([tokenStub, { match: PAGE1, response: { body: {} } }]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r).toEqual({ items: [], nextCursor: null, cursorMeta: { pending_token: null, pending_newest: null } });
    expect(eventsOfKind(sql, "coverage_gap")).toHaveLength(0);
  });

  it("a 401 from the reviews endpoint is systemic AND forgets the cached bearer, so the next run re-exchanges", async () => {
    const s = stubFetch([
      tokenStub,
      { match: PAGE1, response: { status: 401, body: { error: { code: 401 } } } },
      tokenStub,
      { match: PAGE1, response: { body: page([review("old", cursorSecs - 1)]) } },
    ]);
    restore = s.restore;
    const ctx = { sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} };
    await expect(playstoreAdapter.fetch(ctx)).rejects.toBeInstanceOf(SystemicError);
    await playstoreAdapter.fetch(ctx);
    expect(s.urls.filter((u) => /token$/.test(u))).toHaveLength(2);
  });

  it("a rejected token whose restart ends BEFORE the cursor holds one more run instead of advancing over the gap", async () => {
    // Pages between the old token and the cursor were fetched by no run; if Google now
    // serves an empty untokened list, that may be transient — give it one more look.
    const s = stubFetch([
      tokenStub,
      { match: pageWith("STALE"), response: { status: 400, body: {} } },
      { match: PAGE1, response: { body: {} } },
    ]);
    restore = s.restore;
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR,
      cursorMeta: { pending_token: "STALE", pending_newest: iso(cursorSecs + 300) },
    });
    expect(r.nextCursor).toBeNull();
    expect(r.cursorMeta).toEqual({ pending_token: null, pending_newest: iso(cursorSecs + 300) });
    const gaps = eventsOfKind(sql, "coverage_gap");
    expect(gaps).toHaveLength(1);
    expect(String(gaps[0]!.values.find((v) => typeof v === "string" && /rejected the remembered page token/.test(v)))).toContain("held for one more run");
    // next run: nothing to resume, Google still empty → covered as far as Google knows: advance to the remembered newest
    const s2 = stubFetch([{ match: PAGE1, response: { body: {} } }]);
    restore = () => { s2.restore(); s.restore(); };
    const r2 = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: r.cursorMeta ?? {} });
    expect(r2.nextCursor).toBe(iso(cursorSecs + 300));
    expect(r2.cursorMeta).toEqual({ pending_token: null, pending_newest: null });
  });

  it("a 400 on a fresh walk (no resume token) is systemic", async () => {
    const s = stubFetch([tokenStub, { match: PAGE1, response: { status: 400, body: { error: { code: 400 } } } }]);
    restore = s.restore;
    await expect(
      playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
    ).rejects.toBeInstanceOf(SystemicError);
  });

  it("an edited review (id already stored on this stream) is dropped, but the cursor still moves past it", async () => {
    const s = stubFetch([tokenStub, { match: PAGE1, response: { body: page([review("a", cursorSecs + 300), review("b", cursorSecs + 200), review("old", cursorSecs - 1)]) } }]);
    restore = s.restore;
    const sql = fakeSql();
    sql.when(/from raw_items/, [{ external_id: "a" }]);
    const r = await playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items.map((i) => i.externalId)).toEqual(["b"]);
    expect(r.nextCursor).toBe(iso(cursorSecs + 300));
    const dedupe = sql.calls.find((c) => /from raw_items/.test(c.text))!;
    expect(dedupe.values).toContain("reviews/t1"); // scoped to this stream
  });

  it("404 (unknown package or no Play Console access) and 403 are systemic: breaker, cursor untouched", async () => {
    for (const status of [404, 403]) {
      resetPlayTokenCache();
      const s = stubFetch([tokenStub, { match: PAGE1, response: { status, body: { error: { code: status } } } }]);
      await expect(
        playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
      ).rejects.toBeInstanceOf(SystemicError);
      s.restore();
    }
  });

  it("429 and 5xx are transient (cursor held, retried); so is a network failure", async () => {
    for (const status of [429, 503]) {
      resetPlayTokenCache();
      const s = stubFetch([tokenStub, { match: PAGE1, response: { status, body: {} } }]);
      await expect(
        playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
      ).rejects.toBeInstanceOf(TransientError);
      s.restore();
    }
    resetPlayTokenCache();
    const s = stubFetch([tokenStub]); // the reviews call itself is unstubbed → fetch throws
    restore = s.restore;
    await expect(
      playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("a rejected token exchange (400 invalid_grant) is systemic; a 503 from the token endpoint is transient", async () => {
    let s = stubFetch([{ match: /oauth2\.googleapis\.com\/token/, response: { status: 400, body: { error: "invalid_grant" } } }]);
    await expect(
      playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
    ).rejects.toBeInstanceOf(SystemicError);
    s.restore();
    resetPlayTokenCache();
    s = stubFetch([{ match: /oauth2\.googleapis\.com\/token/, response: { status: 503, body: {} } }]);
    restore = s.restore;
    await expect(
      playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("the bearer token is cached: two fetches, one token exchange", async () => {
    const s = stubFetch([
      tokenStub,
      { match: PAGE1, response: { body: page([review("old", cursorSecs - 1)]) } },
      { match: PAGE1, response: { body: page([review("old", cursorSecs - 1)]) } },
    ]);
    restore = s.restore;
    const ctx = { sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} };
    await playstoreAdapter.fetch(ctx);
    await playstoreAdapter.fetch(ctx);
    expect(s.urls.filter((u) => /token$/.test(u))).toHaveLength(1);
    expect(s.urls.filter((u) => /reviews/.test(u))).toHaveLength(2);
  });

  it("the JWT is RS256-signed by the service account and carries the androidpublisher scope", async () => {
    const s = stubFetch([tokenStub, { match: PAGE1, response: { body: page([]) } }]);
    restore = s.restore;
    await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    const init = s.inits[0]!;
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, sig] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims.iss).toBe(EMAIL);
    expect(claims.scope).toBe("https://www.googleapis.com/auth/androidpublisher");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.exp - claims.iat).toBe(3600);
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, sig!, "base64url")).toBe(true);
    // the same key signs deterministically-structured tokens; a different iat changes the claims
    expect(buildJwt(parseServiceAccount(SA)!, 1_000).split(".")[1]).not.toBe(buildJwt(parseServiceAccount(SA)!, 2_000).split(".")[1]);
    // the reviews call carries the bearer token
    expect((s.inits[1]!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("expands one app target into one reviews/<uuid> stream; other kinds are ignored", () => {
    const streams = playstoreAdapter.streams(monitorWith(), [
      target({ id: "aaa", source: "playstore", kind: "app", value: PKG }),
      target({ id: "bbb", source: "playstore", kind: "keyword", value: "acme" }),
    ]);
    expect(streams.map((s) => s.stream)).toEqual(["reviews/aaa"]);
    expect(streams[0]!.target?.id).toBe("aaa");
  });

  it("a target that is not a package name fails systemically before any network call", async () => {
    const s = stubFetch([]);
    restore = s.restore;
    await expect(
      playstoreAdapter.fetch({
        sql: fakeSql().db, monitor: monitorWith(), cursor: CURSOR, cursorMeta: {},
        stream: { stream: "reviews/t1", target: target({ source: "playstore", kind: "app", value: "Acme Widgets" }) },
      }),
    ).rejects.toBeInstanceOf(SystemicError);
    expect(s.urls).toEqual([]);
    expect(parsePackageName("https://play.google.com/store/apps/details?id=com.acme.app&hl=en")).toBe("com.acme.app");
    expect(parsePackageName(" com.acme.app ")).toBe("com.acme.app");
    expect(parsePackageName("com")).toBeNull();
    expect(parsePackageName("https://play.google.com/store/apps/details?id=1bad")).toBeNull();
  });

  it("item shape: tab-joined title becomes a paragraph break, developer reply and rating ride in context, thumbs-up is engagement", async () => {
    const withReply = {
      ...review("r1", cursorSecs + 60, { starRating: 2, thumbsUpCount: 14, device: "Pixel 8" }, "Great title\tThe body text here, long enough."),
    };
    (withReply.comments as unknown[]).push({ developerComment: { text: "Thanks, fixed in 4.3", lastModified: { seconds: String(cursorSecs + 120) } } });
    const s = stubFetch([tokenStub, { match: PAGE1, response: { body: page([withReply, { reviewId: "no-text", comments: [{ userComment: { text: "", lastModified: { seconds: String(cursorSecs + 30) } } }] }]) } }]);
    restore = s.restore;
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items).toHaveLength(1);
    expect(r.droppedCount).toBe(1); // the empty-text review is a parse drop, not a crash
    const item = r.items[0]!;
    expect(item.content).toBe("Great title\n\nThe body text here, long enough.");
    expect(item.context).toEqual({ channel_name: "Google Play", rating: 2, app_version: "4.2.0", developer_reply: "Thanks, fixed in 4.3" });
    expect(item.metrics.thumbs_up).toBe(14);
    expect(item.metrics.device).toBe("Pixel 8");
    expect(item.engagement).toBe(14);
    expect(item.impressions).toBeNull();
    expect(item.url).toBe(`https://play.google.com/store/apps/details?id=${PKG}&reviewId=r1`);
    expect(item.postedAt.toISOString()).toBe(iso(cursorSecs + 60));
  });
});
