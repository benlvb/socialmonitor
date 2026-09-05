import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemicError, TransientError, parseMonitorConfig } from "@socialmonitor/shared";
import { fakeSql, stubFetch } from "./helpers/fake-sql";
import type { MonitorRow, TargetRow } from "../src/db/repos";
import { xAdapter } from "../src/adapters/x";
import { redditAdapter } from "../src/adapters/reddit";
import { discordAdapter } from "../src/adapters/discord";
import { appstoreAdapter } from "../src/adapters/appstore";

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
  /** A full 50-entry page, newest-first, all newer than the cursor. */
  const fullPage = (page: number) =>
    feed(Array.from({ length: 50 }, (_, k) => review(100_000 - page * 100 - k, iso(10_000 - page * 100 - k))));
  const appTarget = target({ source: "appstore", kind: "app", value: "310633997" });
  const streamDef = { stream: "reviews/us/t1", target: appTarget };
  const eventsOfKind = (sql: ReturnType<typeof fakeSql>, kind: string) =>
    sql.calls.filter((c) => /insert into pipeline_events/.test(c.text) && c.values.includes(kind));

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

  it("a short page means the feed is exhausted: window covered, cursor advances", async () => {
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
    expect(r.nextCursor).toBe(iso(10_000 - 100));
    expect(s.urls).toHaveLength(2);
    expect(eventsOfKind(sql, "coverage_lost")).toHaveLength(0);
  });

  it("Apple's 10-page cap is lossy-but-covered: cursor ADVANCES with a coverage_lost error", async () => {
    const s = stubFetch(
      Array.from({ length: 10 }, (_, k) => ({
        match: new RegExp(`page=${k + 1}/json`), response: { body: fullPage(k + 1) },
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
      Array.from({ length: 10 }, (_, k) => ({ match: new RegExp(`page=${k + 1}/json`), response: { body: broken(k + 1) } })),
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
    // Scoped to this stream: an id stored by another storefront must not
    // suppress it here (review S1).
    const dedupe = sql.calls.find((c) => /from raw_items/.test(c.text));
    expect(dedupe?.text).toContain("stream = ?");
    expect(dedupe?.values).toContain("reviews/us/t1");
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
