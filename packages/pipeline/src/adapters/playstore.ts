import { createSign } from "node:crypto";
import {
  SystemicError,
  TransientError,
  clampFutureDate,
  errorFromStatus,
  type RawItem,
} from "@socialmonitor/shared";
import { hasEventToday, type MonitorRow, type TargetRow } from "../db/repos";
import { logEvent } from "../events";
import type { FetchContext, FetchResult, SourceAdapter, StreamDef } from "./types";
import { resolveCredentials } from "./credentials";
import { fixtureMode, loadFixture } from "./fixtures";

/**
 * Google Play reviews (D24) over the official Android Publisher API
 * (`androidpublisher.googleapis.com/v3/applications/<package>/reviews`).
 *
 * API reality: your OWN apps only — a service account invited in the Play Console
 * with "View app information"; competitor apps need a scraper transport later
 * (the x_scraper / x_api precedent, D5). Google returns the reviews that carry
 * text, newest `lastModified` first, 100 per page by opaque `token` pagination,
 * and only those modified in roughly the last seven days — a backfill can never
 * reach further back, and the forward-only first sync plus the fetch cadence is
 * what keeps coverage contiguous.
 *
 * Auth: an RS256 JWT (node:crypto, no SDK) exchanged for a one-hour bearer
 * token, cached in module scope per client_email with a five-minute margin.
 *
 * Streams: one per app target, `reviews/<target uuid>` — the API has no country
 * split, so no storefront dimension (unlike appstore).
 *
 * Cursor: ISO `lastModified` of the newest review seen. Walk newest-first until
 * an entry STRICTLY older than the cursor (window covered) or the list ends.
 * `limits.max_pages_per_fetch` bounds each run; when the budget runs out with
 * pages still newer than the cursor, the cursor HOLDS and cursor_meta remembers
 * Google's `nextPageToken` (`pending_token`) and the newest lastModified seen
 * (`pending_newest`). The next run resumes from that token and, once the walk
 * completes, advances to `pending_newest`. A rejected (stale) token restarts
 * the walk from page 1 — nothing is skipped, because the pages before the token
 * were stored by the run that saved it. Every hold emits a per-stream
 * `coverage_gap` (debounced per stream, per day).
 *
 * Edited reviews resurface with a new `lastModified` and the same reviewId; ids
 * already stored on this stream are dropped, first-seen text kept (the raw_items
 * PK includes posted_at, so a second row would double the theme item count).
 *
 * SECOND TRANSPORT (D25): `app_public` targets read ANY app's reviews from the
 * public store pages through `google-play-scraper` (unofficial, no credential —
 * the x_scraper posture). Probed 2026-09-06 (Money Manager, 10M+ installs): Google
 * serves 150 reviews per request newest-first by `date` (ISO, ms precision) with an
 * opaque `nextPaginationToken` for item 151; the library then SLICES client-side to
 * `num` while still returning that token, so any `num` below the server page skips
 * the remainder silently — the adapter asks for far more than a page (review #7
 * F1). `lang` filters the set and `country` does not (so the dimension is language:
 * `limits.playstore_langs`, streams `public/<lang>/<uuid>`).
 * An unknown app AND a stale token both come back as an empty page with no token,
 * so `app()` (which throws 404 for unknown packages) disambiguates on the first
 * sync and on an empty first page, and an empty resumed page restarts the walk
 * from page 1 instead of ending it. The library is imported lazily so a worker
 * with no public targets never loads it.
 */

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const PAGE_SIZE = 100;
const TOKEN_TTL_MARGIN_MS = 300_000;
const BAD_KEY_MSG = "GOOGLE_SERVICE_ACCOUNT_JSON is not a service-account key file (needs client_email and private_key)";
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** GOOGLE_SERVICE_ACCOUNT_JSON → key material, or null when it is not a service-account key file. */
export function parseServiceAccount(raw: string | undefined | null): ServiceAccount | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.client_email !== "string" || !o.client_email) return null;
  if (typeof o.private_key !== "string" || !o.private_key.includes("PRIVATE KEY")) return null;
  return {
    client_email: o.client_email,
    private_key: o.private_key,
    token_uri: typeof o.token_uri === "string" && o.token_uri ? o.token_uri : undefined,
  };
}

/** Accepts a package name (`com.acme.app`) or a Play Store URL carrying `?id=<package>`. */
export function parsePackageName(value: string): string | null {
  const v = (value ?? "").trim();
  if (PACKAGE_RE.test(v)) return v;
  try {
    const id = new URL(v).searchParams.get("id") ?? "";
    return PACKAGE_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/** RS256 JWT for the OAuth2 service-account flow: header.claims.signature. */
export function buildJwt(sa: ServiceAccount, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri ?? TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key, "base64url");
  return `${header}.${claims}.${signature}`;
}

let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

/** Tests only: forget the cached bearer token. */
export function resetPlayTokenCache(): void {
  cachedToken = null;
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.key === sa.client_email && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  let assertion: string;
  try {
    assertion = buildJwt(sa);
  } catch (err) {
    throw new SystemicError(`playstore: cannot sign the service-account JWT (bad private_key?): ${String(err)}`);
  }
  let res: Response;
  try {
    res = await fetch(sa.token_uri ?? TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TransientError(`playstore token fetch failed: ${String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 300));
    // 400 invalid_grant / 401 / 403: the key or its Play Console grant is wrong (operator error,
    // breaker). 429 / 5xx: Google, retry.
    if (res.status === 429 || res.status >= 500) throw new TransientError(`playstore token ${res.status}: ${body}`);
    throw new SystemicError(`playstore token ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new SystemicError("playstore token response carried no access_token");
  cachedToken = {
    key: sa.client_email,
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - TOKEN_TTL_MARGIN_MS,
  };
  return cachedToken.token;
}

interface PlayTimestamp {
  seconds?: string | number;
  nanos?: number;
}
interface PlayUserComment {
  text?: string;
  lastModified?: PlayTimestamp;
  starRating?: number;
  reviewerLanguage?: string;
  device?: string;
  androidOsVersion?: number;
  appVersionCode?: number;
  appVersionName?: string;
  thumbsUpCount?: number;
  thumbsDownCount?: number;
}
interface PlayDeveloperComment {
  text?: string;
  lastModified?: PlayTimestamp;
}
export interface PlayReview {
  reviewId?: string;
  authorName?: string;
  comments?: { userComment?: PlayUserComment; developerComment?: PlayDeveloperComment }[];
}
interface ReviewsPage {
  reviews?: PlayReview[];
  tokenPagination?: { nextPageToken?: string };
}

function secondsToDate(ts?: PlayTimestamp): Date | null {
  const n = Number(ts?.seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

export function parsePlayReview(monitorId: string, stream: string, pkg: string, r: PlayReview): RawItem | null {
  const id = r.reviewId?.trim();
  const user = r.comments?.find((c) => c?.userComment)?.userComment;
  const postedAt = secondsToDate(user?.lastModified);
  if (!id || !user || !postedAt) return null;
  // Google joins an optional title and the body with a tab.
  const content = (user.text ?? "").replace(/\t+/g, "\n\n").trim();
  if (!content) return null;
  const rating = Number(user.starRating);
  const hasRating = Number.isInteger(rating) && rating >= 1 && rating <= 5;
  const version = user.appVersionName ?? "";
  const reply = r.comments?.find((c) => c?.developerComment)?.developerComment?.text?.trim() ?? "";
  const thumbsUp = Number(user.thumbsUpCount ?? 0) || 0;
  const author = (r.authorName ?? "").trim();
  return {
    monitorId,
    source: "playstore",
    externalId: id,
    stream,
    url: `https://play.google.com/store/apps/details?id=${pkg}&reviewId=${encodeURIComponent(id)}`,
    authorId: author || id,
    authorHandle: author,
    authorName: author,
    authorFollowers: null,
    content,
    postedAt: clampFutureDate(postedAt),
    parentExternalId: "",
    context: {
      channel_name: "Google Play",
      ...(hasRating ? { rating } : {}),
      ...(version ? { app_version: version } : {}),
      ...(reply ? { developer_reply: reply } : {}),
    },
    metrics: {
      rating: hasRating ? rating : null,
      version,
      version_code: user.appVersionCode ?? null,
      language: user.reviewerLanguage ?? "",
      device: user.device ?? "",
      android_os_version: user.androidOsVersion ?? null,
      thumbs_up: thumbsUp,
      thumbs_down: Number(user.thumbsDownCount ?? 0) || 0,
      has_developer_reply: Boolean(reply),
    },
    impressions: null, // Google exposes no view counts (D15 — labeled proxy)
    engagement: thumbsUp,
  };
}

async function listReviews(
  token: string,
  pkg: string,
  pageToken?: string,
): Promise<{ status: number; page: ReviewsPage | null }> {
  const url = new URL(`${API}/${encodeURIComponent(pkg)}/reviews`);
  url.searchParams.set("maxResults", String(PAGE_SIZE));
  if (pageToken) url.searchParams.set("token", pageToken);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new TransientError(`playstore fetch failed: ${String(err)}`);
  }
  // 400 is how the API rejects a stale page token; the caller disambiguates.
  if (res.status === 400) return { status: 400, page: null };
  if (res.status === 401) cachedToken = null; // dead bearer: re-exchange next run instead of replaying it for an hour
  if (!res.ok) throw errorFromStatus(res.status, await res.text().then((t) => t.slice(0, 300)));
  return { status: res.status, page: (await res.json()) as ReviewsPage };
}

/** ISO of the newest postedAt across `items`, folding in an earlier ISO (a remembered newest) when given. */
function newestIso(items: RawItem[], also?: string | null): string | null {
  const times = items.map((i) => i.postedAt.getTime());
  if (also) times.push(new Date(also).getTime());
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

interface PendingMeta {
  pending_token?: string | null;
  pending_newest?: string | null;
}

export const playstoreAdapter: SourceAdapter = {
  source: "playstore",

  async status(sql, ownerId) {
    if (fixtureMode()) return { configured: true, detail: "fixture mode" };
    const creds = await resolveCredentials(sql, ownerId, "google_play");
    // The public transport (app_public targets) needs no credential, so the source
    // is always configured; own-app (`app`) streams skip silently without a key.
    if (!creds) return { configured: true, detail: "public-app targets only — GOOGLE_SERVICE_ACCOUNT_JSON not configured for own-app targets" };
    // A present-but-broken key is configured (so fetch runs and trips the breaker
    // visibly) rather than silently unconfigured.
    return parseServiceAccount(creds.GOOGLE_SERVICE_ACCOUNT_JSON)
      ? { configured: true }
      : {
          configured: true,
          detail: "GOOGLE_SERVICE_ACCOUNT_JSON is set but is not a service-account key (client_email + private_key) — fetches fail systemically until fixed",
        };
  },

  async testConnection(sql, ownerId) {
    const creds = await resolveCredentials(sql, ownerId, "google_play");
    if (!creds) return { ok: false, message: "no credentials" };
    const sa = parseServiceAccount(creds.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!sa) return { ok: false, message: BAD_KEY_MSG };
    try {
      await getAccessToken(sa);
      return { ok: true, message: `token obtained for ${sa.client_email}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  streams(monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    const out: StreamDef[] = [];
    for (const t of targets) {
      if (t.kind === "app") out.push({ stream: `reviews/${t.id}`, target: t });
      if (t.kind === "app_public") {
        for (const lang of monitor.config.limits.playstore_langs) {
          out.push({ stream: `public/${lang}/${t.id}`, target: t });
        }
      }
    }
    return out;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
    if (stream.stream.startsWith("public/")) return fetchPublic(ctx);
    if (fixtureMode()) {
      if (cursor) return { items: [], nextCursor: null };
      const reviews = await loadFixture<PlayReview[]>("playstore");
      const items = reviews
        .map((r) => parsePlayReview(monitor.id, stream.stream, "com.example.app", r))
        .filter((i): i is RawItem => i !== null);
      return { items, nextCursor: newestIso(items), droppedCount: reviews.length - items.length };
    }

    const creds = await resolveCredentials(sql, monitor.owner_id, "google_play");
    if (!creds) return { items: [], nextCursor: null }; // unconfigured is a state (D22)
    const sa = parseServiceAccount(creds.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!sa) throw new SystemicError(`playstore: ${BAD_KEY_MSG}`);

    // Forward-only first sync (SPEC §9): backfill is a deliberate action.
    if (!cursor) return { items: [], nextCursor: new Date().toISOString() };

    const pkg = parsePackageName(stream.target?.value ?? "");
    if (!pkg) {
      throw new SystemicError(`playstore target is not a package name or Play URL: ${stream.target?.value ?? stream.stream}`);
    }
    const cursorMs = new Date(cursor).getTime();
    const meta = ctx.cursorMeta as PendingMeta;
    const maxPages = monitor.config.limits.max_pages_per_fetch;
    const token = await getAccessToken(sa);

    const newer: RawItem[] = [];
    let dropped = 0;
    let pageToken: string | undefined = meta.pending_token || undefined;
    let resuming = pageToken !== undefined;
    let restarted = false; // a remembered token was rejected this run
    let coveredToCursor = false; // some page reached an entry older than the cursor
    let completed = false;

    for (let page = 0; page < maxPages; page++) {
      const { status, page: data } = await listReviews(token, pkg, pageToken);
      if (status === 400 || !data) {
        if (resuming) {
          // Stale resume token: start over from page 1. The pages before the token
          // were stored by the run that saved it, so nothing is skipped.
          console.warn(`[playstore] ${stream.stream}: resume token rejected; restarting the walk from page 1`);
          pageToken = undefined;
          resuming = false;
          restarted = true;
          continue;
        }
        throw new SystemicError(`playstore API rejected the reviews request for ${pkg} (400)`);
      }
      resuming = false;
      const reviews = data.reviews ?? [];
      let reachedCursor = false;
      for (const r of reviews) {
        const item = parsePlayReview(monitor.id, stream.stream, pkg, r);
        if (!item) {
          dropped++;
          continue;
        }
        // Strictly older ends the walk; a review in the cursor's own second may be
        // new (`lastModified` is second-granular) — keep it, the dedupe below decides.
        if (item.postedAt.getTime() < cursorMs) {
          reachedCursor = true;
          continue;
        }
        newer.push(item);
      }
      // Google's token is the authority on whether more pages exist: an empty page
      // that still carries one is not the end (proto3 JSON omits empty `reviews`),
      // so only the cursor or a missing token ends the walk; maxPages bounds it.
      const next = data.tokenPagination?.nextPageToken;
      if (reachedCursor) coveredToCursor = true;
      if (reachedCursor || !next) {
        completed = true;
        pageToken = undefined;
        break;
      }
      pageToken = next;
    }
    if (completed && restarted && !coveredToCursor) {
      // The restart after a rejected token hit the end of Google's list without reaching
      // the cursor: the pages between the old token and the cursor were fetched by no run.
      // Hold once more (token gone, newest kept) so a transient blank gets a second look;
      // the next run walks fresh and, if Google still has nothing, advances.
      completed = false;
    }

    let blankWithMemory = false;
    if (completed && newer.length === 0 && !coveredToCursor && (meta.pending_newest || meta.pending_token)) {
      // Nothing observed this run while an earlier, unfinished walk left a remembered
      // newest: cashing it in would advance over pages no run fetched (review #7 F2).
      // Fall through to the hold path so the stall is not silent (review #7 round 2).
      completed = false;
      blankWithMemory = true;
    }

    // Drop ids already stored ON THIS STREAM (edits, the boundary review) — on the
    // hold path too, since that path re-walks and meets edits most.
    let items = newer;
    if (newer.length > 0) {
      const ids = newer.map((i) => i.externalId);
      const rows = await sql`
        select external_id from raw_items
        where monitor_id = ${monitor.id} and source = 'playstore'
          and stream = ${stream.stream} and external_id = any(${ids}::text[])`;
      const seen = new Set(rows.map((r) => r.external_id as string));
      if (seen.size > 0) items = newer.filter((i) => !seen.has(i.externalId));
    }

    const newestSeen = newestIso(newer, meta.pending_newest);
    const extra = dropped > 0 ? { droppedCount: dropped } : {};
    if (completed) {
      // Window covered (this run, or this run plus the remembered earlier one):
      // advance to the newest lastModified across both. null = nothing newer = hold.
      return { items, nextCursor: newestSeen, cursorMeta: { pending_token: null, pending_newest: null }, ...extra };
    }

    // Budget exhausted with pages still newer than the cursor: HOLD, remember where
    // to resume, say so once a day per stream.
    if (!(await hasEventToday(sql, monitor.id, "coverage_gap", stream.stream))) {
      await logEvent(sql, {
        monitorId: monitor.id,
        source: "playstore",
        stream: stream.stream,
        level: "warn",
        kind: "coverage_gap",
        message: blankWithMemory
          ? "Google served nothing while an earlier walk's newest is still pending; cursor held and the memory kept until a page reaches the cursor"
          : restarted && !pageToken
            ? "Google rejected the remembered page token and the fresh walk ended before reaching the cursor; cursor held for one more run"
            : `the run budget (limits.max_pages_per_fetch = ${maxPages}) ran out before the walk reached the cursor; cursor held, the walk resumes from Google's page token next run`,
      });
    }
    return {
      items,
      nextCursor: null,
      cursorMeta: { pending_token: pageToken ?? null, pending_newest: newestSeen },
      ...extra,
    };
  },
};

// ── Public transport (D25): any app, no credential, via google-play-scraper ──

import type { IFnAppOptions, IFnReviewsOptions, IReviewsItem, IReviewsResult } from "google-play-scraper";

/**
 * `num` is a CLIENT-SIDE slice in google-play-scraper: every request asks Google
 * for its fixed server page (150) and returns the token for the item after it,
 * then `data` is cut to `num`. A value below the server page loses the rest of
 * the page for good, so ask for far more than one; `paginate: true` still issues
 * exactly one request per call.
 */
const PUBLIC_NUM = 1000;
/** Requests per second against the public store pages — be a polite scraper. */
const PUBLIC_THROTTLE = 2;
/** got request options the library forwards (untyped in its d.ts). A stalled request
 * would otherwise hold the stream lock and the poll batch forever. */
const PUBLIC_REQUEST_OPTIONS = { timeout: { request: 30_000 } } as const;

type WithRequestOptions<T> = T & { requestOptions?: { timeout?: { request?: number } } };
/** The slice of the library the transport uses — injectable for tests. */
export interface PlayScraper {
  reviews(options: WithRequestOptions<IFnReviewsOptions>): Promise<IReviewsResult>;
  app(options: WithRequestOptions<IFnAppOptions>): Promise<unknown>;
  sort: { NEWEST: NonNullable<IFnReviewsOptions["sort"]> };
}
/** A review as the library returns it; fields the parser reads are tolerated missing or null. */
export type PublicReview = Pick<IReviewsItem, "id" | "date"> & { [K in keyof Omit<IReviewsItem, "id" | "date">]?: IReviewsItem[K] | null };

let scraperPromise: Promise<PlayScraper> | null = null;
/** Lazy: a worker with no app_public targets never loads the library. */
function loadScraper(): Promise<PlayScraper> {
  scraperPromise ??= import("google-play-scraper").then((m) => m.default as unknown as PlayScraper);
  return scraperPromise;
}
/** Tests only: inject a scripted library. */
export function setPlayScraperForTests(impl: PlayScraper | null): void {
  scraperPromise = impl ? Promise.resolve(impl) : null;
}

/** The library throws plain Errors with a `status` for HTTP failures. */
function classifyScraperError(err: unknown, what: string): Error {
  const status = Number((err as { status?: unknown })?.status);
  const msg = String((err as Error)?.message ?? err);
  if (status === 404 || /not found/i.test(msg)) return new SystemicError(`playstore public: ${what}: ${msg}`);
  if (status === 401 || status === 403) return new SystemicError(`playstore public: ${what}: ${msg}`);
  return new TransientError(`playstore public: ${what}: ${msg}`);
}

export function parsePublicReview(monitorId: string, stream: string, lang: string, pkg: string, r: PublicReview): RawItem | null {
  const id = (r.id ?? "").trim();
  if (!id || !r.date) return null;
  const postedAt = new Date(r.date);
  if (Number.isNaN(postedAt.getTime())) return null;
  const title = (r.title ?? "").trim();
  const body = (r.text ?? "").trim();
  // Play no longer shows titles (0 of 200 probed), but the field exists: collapse
  // a title repeated inside the body the way the App Store adapter does.
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  const content = !title ? body : !body ? title : b.includes(t) ? body : t.includes(b) ? title : `${title}\n\n${body}`;
  if (!content) return null;
  const rating = Number(r.score);
  const hasRating = Number.isInteger(rating) && rating >= 1 && rating <= 5;
  const version = (r.version ?? "").trim();
  const reply = (r.replyText ?? "").trim();
  const thumbsUp = Number(r.thumbsUp ?? 0) || 0;
  const author = (r.userName ?? "").trim();
  return {
    monitorId,
    source: "playstore",
    externalId: id,
    stream,
    url: r.url || `https://play.google.com/store/apps/details?id=${pkg}&reviewId=${encodeURIComponent(id)}`,
    authorId: author || id,
    authorHandle: author,
    authorName: author,
    authorFollowers: null,
    content,
    postedAt: clampFutureDate(postedAt),
    parentExternalId: "",
    context: {
      channel_name: `Google Play (${lang})`,
      ...(hasRating ? { rating } : {}),
      ...(version ? { app_version: version } : {}),
      ...(reply ? { developer_reply: reply } : {}),
    },
    metrics: {
      rating: hasRating ? rating : null,
      version,
      language: lang,
      thumbs_up: thumbsUp,
      has_developer_reply: Boolean(reply),
      reply_date: r.replyDate ?? null,
      transport: "public",
    },
    impressions: null, // Google exposes no view counts (D15 — labeled proxy)
    engagement: thumbsUp,
  };
}

/** `public/<lang>/<target uuid>` -> language code. */
function langOf(stream: string): string | null {
  const parts = stream.split("/");
  return parts[0] === "public" && parts[1] ? parts[1] : null;
}

async function fetchPublic(ctx: FetchContext): Promise<FetchResult> {
  const { sql, monitor, stream, cursor } = ctx;
  const lang = langOf(stream.stream);
  if (fixtureMode()) {
    if (cursor) return { items: [], nextCursor: null };
    const reviews = await loadFixture<PublicReview[]>("playstore-public");
    const items = reviews
      .map((r) => parsePublicReview(monitor.id, stream.stream, lang ?? "en", "com.example.app", r))
      .filter((i): i is RawItem => i !== null);
    return { items, nextCursor: newestIso(items), droppedCount: reviews.length - items.length };
  }

  const pkg = parsePackageName(stream.target?.value ?? "");
  if (!lang || !pkg) {
    throw new SystemicError(`playstore public target is not a package name or Play URL: ${stream.target?.value ?? stream.stream}`);
  }
  const gplay = await loadScraper();

  // Unknown packages come back as an EMPTY review list, not an error; only
  // app() says 404. Check once, on the first sync, so a typo trips the breaker
  // instead of holding forever on "nothing newer".
  if (!cursor) {
    try {
      await gplay.app({ appId: pkg, lang, throttle: PUBLIC_THROTTLE, requestOptions: PUBLIC_REQUEST_OPTIONS });
    } catch (err) {
      throw classifyScraperError(err, `app lookup for ${pkg}`);
    }
    return { items: [], nextCursor: new Date().toISOString() };
  }

  const cursorMs = new Date(cursor).getTime();
  const meta = ctx.cursorMeta as PendingMeta;
  const maxPages = monitor.config.limits.max_pages_per_fetch;

  const newer: RawItem[] = [];
  let dropped = 0;
  let pageToken: string | undefined = meta.pending_token || undefined;
  let resuming = pageToken !== undefined;
  let restarted = false;
  let coveredToCursor = false;
  let completed = false;

  for (let page = 0; page < maxPages; page++) {
    let result;
    try {
      result = await gplay.reviews({
        appId: pkg,
        lang,
        sort: gplay.sort.NEWEST,
        num: PUBLIC_NUM,
        paginate: true,
        ...(pageToken ? { nextPaginationToken: pageToken } : {}),
        throttle: PUBLIC_THROTTLE,
        requestOptions: PUBLIC_REQUEST_OPTIONS,
      });
    } catch (err) {
      throw classifyScraperError(err, `reviews for ${pkg}/${lang}`);
    }
    const data = result.data ?? [];
    const next = result.nextPaginationToken || undefined;

    if (resuming && data.length === 0 && !next) {
      // A stale resume token is indistinguishable from the end of the list
      // (probed: both are an empty page with no token). Restart from page 1;
      // the pages before the token were stored by the run that saved it.
      console.warn(`[playstore] ${stream.stream}: resumed page came back empty; restarting the walk from page 1`);
      pageToken = undefined;
      resuming = false;
      restarted = true;
      continue;
    }
    resuming = false;

    if (page === 0 && !restarted && data.length === 0 && !next) {
      // Empty first page: no reviews in this language, or the app is gone.
      try {
        await gplay.app({ appId: pkg, lang, throttle: PUBLIC_THROTTLE, requestOptions: PUBLIC_REQUEST_OPTIONS });
      } catch (err) {
        throw classifyScraperError(err, `app lookup for ${pkg}`);
      }
      completed = true;
      break;
    }

    let reachedCursor = false;
    for (const r of data) {
      const item = parsePublicReview(monitor.id, stream.stream, lang, pkg, r);
      if (!item) {
        dropped++;
        continue;
      }
      // Strictly older ends the walk; a review in the cursor's own millisecond
      // is kept and the dedupe below decides.
      if (item.postedAt.getTime() < cursorMs) {
        reachedCursor = true;
        continue;
      }
      newer.push(item);
    }
    if (reachedCursor) coveredToCursor = true;
    if (reachedCursor || !next) {
      completed = true;
      pageToken = undefined;
      break;
    }
    pageToken = next;
  }
  if (completed && restarted && !coveredToCursor) {
    // The restart after an empty resumed page ended before the cursor: hold one
    // more run so a transient blank gets a second look (the official path's rule).
    completed = false;
  }

  const extra = dropped > 0 ? { droppedCount: dropped } : {};
  let blankWithMemory = false;
  if (completed && newer.length === 0 && !coveredToCursor && (meta.pending_newest || meta.pending_token)) {
    // Nothing observed this run (a blank page) while an earlier, unfinished walk
    // left a remembered newest: cashing it in would advance over pages no run
    // fetched. Keep holding, keep the memory (review #7 F2) — through the hold
    // path below, so the stall emits its coverage_gap like every other hold.
    completed = false;
    blankWithMemory = true;
  }

  let items = newer;
  if (newer.length > 0) {
    const ids = newer.map((i) => i.externalId);
    const rows = await sql`
      select external_id from raw_items
      where monitor_id = ${monitor.id} and source = 'playstore'
        and stream = ${stream.stream} and external_id = any(${ids}::text[])`;
    const seen = new Set(rows.map((r) => r.external_id as string));
    if (seen.size > 0) items = newer.filter((i) => !seen.has(i.externalId));
  }

  const newestSeen = newestIso(newer, meta.pending_newest);
  if (completed) {
    return { items, nextCursor: newestSeen, cursorMeta: { pending_token: null, pending_newest: null }, ...extra };
  }
  if (!(await hasEventToday(sql, monitor.id, "coverage_gap", stream.stream))) {
    await logEvent(sql, {
      monitorId: monitor.id,
      source: "playstore",
      stream: stream.stream,
      level: "warn",
      kind: "coverage_gap",
      message: blankWithMemory
        ? "the store served nothing while an earlier walk's newest is still pending; cursor held and the memory kept until a page reaches the cursor"
        : restarted && !pageToken
        ? "the resumed page came back empty and the fresh walk ended before reaching the cursor; cursor held for one more run"
        : `the run budget (limits.max_pages_per_fetch = ${maxPages}) ran out before the walk reached the cursor; cursor held, the walk resumes from the page token next run`,
    });
  }
  return {
    items,
    nextCursor: null,
    cursorMeta: { pending_token: pageToken ?? null, pending_newest: newestSeen },
    ...extra,
  };
}
