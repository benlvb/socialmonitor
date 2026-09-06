import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SystemicError, TransientError, parseMonitorConfig } from "@socialmonitor/shared";
import type { IFnReviewsOptions, IReviewsResult } from "google-play-scraper";
import { fakeSql } from "./helpers/fake-sql";
import type { MonitorRow, TargetRow } from "../src/db/repos";
import { playstoreAdapter, setPlayScraperForTests, type PlayScraper, type PublicReview } from "../src/adapters/playstore";

/**
 * The public (scraper) transport of the Play adapter, driven through the real
 * `fetch` with a scripted library. Facts these encode were probed live on
 * 2026-09-06: an unknown app and a stale token BOTH come back as an empty page
 * with no token; only app() says 404; and the library SLICES each page client-side
 * to `num` while returning the token for the full 150-item server page (review #7
 * F1) — the scripted library below does the same, so the suite can see that bug.
 */
const SERVER_PAGE = 150;

function monitorWith(overrides: Record<string, unknown> = {}): MonitorRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    owner_id: "00000000-0000-0000-0000-000000000002",
    name: "play-public-monitor",
    status: "active",
    config: parseMonitorConfig(overrides),
  };
}
const target = (over: Partial<TargetRow> = {}): TargetRow => ({
  id: "t1",
  monitor_id: "00000000-0000-0000-0000-000000000001",
  source: "playstore",
  kind: "app_public",
  value: "com.realbyteapps.moneymanagerfree",
  enabled: true,
  config: {},
  ...over,
});
const streamDef = { stream: "public/en/t1", target: target() };
const CURSOR = "2026-08-20T12:00:00.000Z";
const cursorMs = Date.parse(CURSOR);
const iso = (offsetMin: number) => new Date(cursorMs + offsetMin * 60_000).toISOString();
const review = (id: string, date: string, extra: Partial<PublicReview> = {}): PublicReview => ({
  id,
  userName: `user ${id}`,
  date,
  score: 4,
  text: `review ${id} with enough words to pass the prefilter`,
  url: `https://play.google.com/store/apps/details?id=com.realbyteapps.moneymanagerfree&reviewId=${id}`,
  version: "4.12.8",
  thumbsUp: 2,
  replyText: null,
  replyDate: null,
  title: null,
  ...extra,
});
const fullPage = (page: number, token: string | null) => ({
  data: Array.from({ length: SERVER_PAGE }, (_, k) => review(`p${page}-${k}`, iso(10_000 - page * 1000 - k))),
  nextPaginationToken: token,
});

type ScriptedPage = { data: PublicReview[]; nextPaginationToken: string | null };
interface Scripted {
  gplay: PlayScraper;
  reviewCalls: (IFnReviewsOptions & { requestOptions?: { timeout?: { request?: number } } })[];
  appCalls: { appId: string; requestOptions?: { timeout?: { request?: number } } }[];
}
/**
 * Each reviews() call consumes the next scripted SERVER page (or throws the scripted
 * error) and, like the real library, returns `data.slice(0, num)` with the token for
 * the whole server page.
 */
function scripted(pages: (ScriptedPage | Error)[], appLookup: "ok" | Error = "ok"): Scripted {
  const reviewCalls: Scripted["reviewCalls"] = [];
  const appCalls: Scripted["appCalls"] = [];
  const queue = [...pages];
  const gplay: PlayScraper = {
    sort: { NEWEST: 2 },
    async reviews(o) {
      reviewCalls.push(o);
      const next = queue.shift();
      if (!next) throw new Error(`unscripted reviews() call #${reviewCalls.length}`);
      if (next instanceof Error) throw next;
      return { data: next.data.slice(0, o.num ?? SERVER_PAGE) as IReviewsResult["data"], nextPaginationToken: next.nextPaginationToken ?? undefined };
    },
    async app(o) {
      appCalls.push({ appId: o.appId, requestOptions: o.requestOptions });
      if (appLookup instanceof Error) throw appLookup;
      return { title: "Money Manager" };
    },
  };
  setPlayScraperForTests(gplay);
  return { gplay, reviewCalls, appCalls };
}
const notFound = () => Object.assign(new Error("App not found (404)"), { status: 404 });
const gapEvents = (sql: ReturnType<typeof fakeSql>) =>
  sql.calls.filter((c) => /insert into pipeline_events/.test(c.text) && c.values.includes("coverage_gap"));

beforeEach(() => {
  delete process.env.FIXTURE_MODE;
});
afterEach(() => {
  setPlayScraperForTests(null);
});

describe("Google Play public transport — status and streams", () => {
  it("needs no credential: status is configured without GOOGLE_SERVICE_ACCOUNT_JSON", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const s = await playstoreAdapter.status(fakeSql().db, monitorWith().owner_id);
    expect(s.configured).toBe(true);
    expect(s.detail).toMatch(/public-app targets only/);
  });
  it("expands one app_public target into one public/<lang>/<uuid> stream per configured language, uuid last", () => {
    const streams = playstoreAdapter.streams(monitorWith({ limits: { playstore_langs: ["en", "ms"] } }), [
      target(),
      target({ id: "t2", kind: "app", value: "com.own.app" }),
    ]);
    expect(streams.map((s) => s.stream)).toEqual(["public/en/t1", "public/ms/t1", "reviews/t2"]);
  });
});

describe("Google Play public transport — cursor semantics", () => {
  it("forward-only first sync validates the package with app() and fetches no reviews", async () => {
    const s = scripted([]);
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: null, cursorMeta: {} });
    expect(r.items).toEqual([]);
    expect(Date.parse(r.nextCursor!)).toBeGreaterThan(Date.now() - 60_000);
    expect(s.appCalls.map((c) => c.appId)).toEqual(["com.realbyteapps.moneymanagerfree"]);
    expect(s.appCalls[0]!.requestOptions?.timeout?.request).toBe(30_000);
    expect(s.reviewCalls).toHaveLength(0);
  });

  it("an unknown package fails systemically on the first sync (app() 404) — a typo trips the breaker, never holds forever", async () => {
    scripted([], notFound());
    await expect(
      playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: null, cursorMeta: {} }),
    ).rejects.toThrow(SystemicError);
  });

  it("walking back to the cursor covers the window: newer items stored, cursor = newest date, meta cleared, lang + NEWEST sent", async () => {
    const s = scripted([{ data: [review("3", iso(120)), review("2", iso(60)), review("1", iso(-60))], nextPaginationToken: "T2" }]);
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items.map((i) => i.externalId)).toEqual(["3", "2"]);
    expect(r.nextCursor).toBe(iso(120));
    expect(r.cursorMeta).toEqual({ pending_token: null, pending_newest: null });
    expect(s.reviewCalls[0]).toMatchObject({ appId: "com.realbyteapps.moneymanagerfree", lang: "en", sort: 2, paginate: true });
    expect(s.reviewCalls[0]).not.toHaveProperty("nextPaginationToken");
    expect(s.reviewCalls[0]!.requestOptions?.timeout?.request).toBe(30_000); // a stalled request must not hold the stream lock forever
  });

  it("a review in the cursor's own instant is kept, not skipped as covered (strict <)", async () => {
    scripted([{ data: [review("4", CURSOR), review("1", iso(-60))], nextPaginationToken: null }]);
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items.map((i) => i.externalId)).toEqual(["4"]);
    expect(r.nextCursor).toBe(CURSOR);
  });

  it("page budget exhausted with pages remaining: HOLD, remember the token and the newest seen, warn once per stream", async () => {
    scripted([fullPage(1, "T2")]);
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith({ limits: { max_pages_per_fetch: 1 } }), stream: streamDef, cursor: CURSOR, cursorMeta: {},
    });
    expect(r.items).toHaveLength(SERVER_PAGE);
    expect(r.nextCursor).toBeNull();
    expect(r.cursorMeta).toEqual({ pending_token: "T2", pending_newest: iso(10_000 - 1000) });
    const gaps = gapEvents(sql);
    expect(gaps).toHaveLength(1);
    const debounce = sql.calls.find((c) => /from pipeline_events/.test(c.text) && c.values.includes("coverage_gap"));
    expect(debounce?.values).toContain("public/en/t1");
  });

  it("resumes from the remembered token, then advances to the remembered newest once the walk completes", async () => {
    const s = scripted([{ data: [review("r1", iso(30)), review("old", iso(-5))], nextPaginationToken: "T3" }]);
    const r = await playstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR,
      cursorMeta: { pending_token: "T2", pending_newest: iso(500) },
    });
    expect(s.reviewCalls[0]).toMatchObject({ nextPaginationToken: "T2" });
    expect(r.items.map((i) => i.externalId)).toEqual(["r1"]);
    expect(r.nextCursor).toBe(iso(500)); // the remembered newest, not this page's
    expect(r.cursorMeta).toEqual({ pending_token: null, pending_newest: null });
  });

  it("a stale resume token (empty page, no token) restarts the walk from page 1 instead of ending it", async () => {
    // Probed: a bogus token returns {data: [], token: null} — identical to the end of the list.
    const s = scripted([
      { data: [], nextPaginationToken: null },
      { data: [review("n1", iso(90)), review("old", iso(-5))], nextPaginationToken: "TX" },
    ]);
    const r = await playstoreAdapter.fetch({
      sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR,
      cursorMeta: { pending_token: "STALE", pending_newest: iso(500) },
    });
    expect(s.reviewCalls.map((c) => c.nextPaginationToken ?? "(none)")).toEqual(["STALE", "(none)"]);
    expect(r.items.map((i) => i.externalId)).toEqual(["n1"]);
    expect(r.nextCursor).toBe(iso(500));
  });

  it("a restart whose fresh walk ends BEFORE the cursor holds one more run instead of advancing over the gap", async () => {
    scripted([
      { data: [], nextPaginationToken: null },
      { data: [review("n1", iso(90))], nextPaginationToken: null }, // list ends, cursor never reached
    ]);
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({
      sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR,
      cursorMeta: { pending_token: "STALE", pending_newest: iso(500) },
    });
    expect(r.items).toHaveLength(1);
    expect(r.nextCursor).toBeNull();
    expect(gapEvents(sql)).toHaveLength(1);
  });

  it("an empty FIRST page re-checks the app: gone → systemic; present → nothing newer, cursor held quietly", async () => {
    scripted([{ data: [], nextPaginationToken: null }], notFound());
    await expect(
      playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} }),
    ).rejects.toThrow(SystemicError);
    const s = scripted([{ data: [], nextPaginationToken: null }]);
    const sql = fakeSql();
    const r = await playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull();
    expect(s.appCalls).toHaveLength(1);
    expect(gapEvents(sql)).toHaveLength(0);
  });

  it("asks for more than a server page, so the library's client-side slice cannot drop reviews (review #7 F1)", async () => {
    // Google serves 150 per request and the library returns the token for item 151
    // regardless of `num`; with num=100 the adapter stored 100 of 141 live reviews
    // and advanced the cursor over the other 41 with no event.
    const s = scripted([fullPage(1, "T2"), { data: [review("old", iso(-5))], nextPaginationToken: null }]);
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(s.reviewCalls[0]!.num).toBeGreaterThanOrEqual(SERVER_PAGE);
    expect(r.items).toHaveLength(SERVER_PAGE); // every review of the page, not a prefix of it
    expect(r.nextCursor).toBe(iso(10_000 - 1000));
  });

  it("an empty first page while a remembered newest is pending HOLDS and keeps the memory (review #7 F2)", async () => {
    scripted([{ data: [], nextPaginationToken: null }]);
    const meta = { pending_token: null, pending_newest: iso(500) };
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: meta });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeNull(); // the regression: advanced to pending_newest having fetched nothing
    expect(r.cursorMeta).toEqual(meta);
  });

  it("an edited review (id already stored on this stream) is dropped, but the cursor still moves past it", async () => {
    scripted([{ data: [review("9", iso(120)), review("8", iso(60)), review("1", iso(-60))], nextPaginationToken: null }]);
    const sql = fakeSql();
    sql.when(/from raw_items/, [{ external_id: "9" }]);
    const r = await playstoreAdapter.fetch({ sql: sql.db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    expect(r.items.map((i) => i.externalId)).toEqual(["8"]);
    expect(r.nextCursor).toBe(iso(120));
    const dedupe = sql.calls.find((c) => /from raw_items/.test(c.text));
    expect(dedupe?.values).toContain("public/en/t1");
  });

  it("library failures classify by status: 404 systemic, 429/5xx/network transient (cursor held)", async () => {
    scripted([Object.assign(new Error("Error requesting Google Play: 429"), { status: 429 })]);
    await expect(playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} })).rejects.toThrow(TransientError);
    scripted([new Error("getaddrinfo ENOTFOUND play.google.com")]);
    await expect(playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} })).rejects.toThrow(TransientError);
    scripted([notFound()]);
    await expect(playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} })).rejects.toThrow(SystemicError);
  });

  it("a target that is not a package name fails systemically before any library call", async () => {
    const s = scripted([]);
    await expect(
      playstoreAdapter.fetch({
        sql: fakeSql().db, monitor: monitorWith(),
        stream: { stream: "public/en/t1", target: target({ value: "money manager" }) }, cursor: CURSOR, cursorMeta: {},
      }),
    ).rejects.toThrow(SystemicError);
    expect(s.reviewCalls).toHaveLength(0);
    expect(s.appCalls).toHaveLength(0);
  });

  it("item shape: developer reply and rating in context, thumbs-up as engagement, language in metrics, title collapsed into the body", async () => {
    scripted([{ data: [review("s1", iso(10), { score: 2, replyText: "Fixed in 4.12.9", replyDate: "2026-08-21T00:00:00.000Z", title: "Needs CSV export", text: "Needs CSV export. PDF-only is useless for us.", thumbsUp: 14 })], nextPaginationToken: null }]);
    const r = await playstoreAdapter.fetch({ sql: fakeSql().db, monitor: monitorWith(), stream: streamDef, cursor: CURSOR, cursorMeta: {} });
    const i = r.items[0]!;
    expect(i.source).toBe("playstore");
    expect(i.content).toBe("Needs CSV export. PDF-only is useless for us.");
    expect(i.context).toMatchObject({ channel_name: "Google Play (en)", rating: 2, app_version: "4.12.8", developer_reply: "Fixed in 4.12.9" });
    expect(i.metrics).toMatchObject({ rating: 2, language: "en", thumbs_up: 14, has_developer_reply: true, transport: "public" });
    expect(i.engagement).toBe(14);
    expect(i.impressions).toBeNull();
    expect(i.url).toContain("reviewId=s1");
  });
});
