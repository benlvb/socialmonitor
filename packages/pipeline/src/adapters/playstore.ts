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
 */

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const PAGE_SIZE = 100;
const TOKEN_TTL_MARGIN_MS = 300_000;
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
  if (!res.ok) throw errorFromStatus(res.status, await res.text().then((t) => t.slice(0, 300)));
  return { status: res.status, page: (await res.json()) as ReviewsPage };
}

function newestIso(items: RawItem[]): string | null {
  if (items.length === 0) return null;
  return new Date(Math.max(...items.map((i) => i.postedAt.getTime()))).toISOString();
}

function laterIso(a: string | null, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
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
    if (!creds) return { configured: false, detail: "GOOGLE_SERVICE_ACCOUNT_JSON not configured" };
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
    if (!sa) {
      return { ok: false, message: "GOOGLE_SERVICE_ACCOUNT_JSON is not a service-account key file (needs client_email and private_key)" };
    }
    try {
      await getAccessToken(sa);
      return { ok: true, message: `token obtained for ${sa.client_email}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  streams(_monitor: MonitorRow, targets: TargetRow[]): StreamDef[] {
    return targets.filter((t) => t.kind === "app").map((t) => ({ stream: `reviews/${t.id}`, target: t }));
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { sql, monitor, stream, cursor } = ctx;
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
    if (!sa) {
      throw new SystemicError(
        "playstore: GOOGLE_SERVICE_ACCOUNT_JSON is not a service-account key file (needs client_email and private_key)",
      );
    }

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
      const next = data.tokenPagination?.nextPageToken;
      if (reachedCursor || !next || reviews.length === 0) {
        completed = true;
        pageToken = undefined;
        break;
      }
      pageToken = next;
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

    const newestSeen = laterIso(newestIso(newer), meta.pending_newest);
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
        message: `more reviews newer than the cursor than limits.max_pages_per_fetch (${maxPages}) pages cover; cursor held, the walk resumes from Google's page token next run`,
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
