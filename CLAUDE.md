# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`socialmonitor` — configurable multi-source social monitoring: X, Reddit, YouTube,
Telegram, Discord, App Store reviews (credential-less), Google Play reviews (own apps) → LLM classification (Haiku, Batch API) → deduped **themes** →
dashboard / `/ask` chat / weekly summaries (Sonnet) / Telegram alerts. Single-operator,
self-hosted, MIT. **`SPEC.md` is the source of truth** (24 confirmed decisions,
D1–D24); read it before designing anything. `docs/runbook/engineer.md` holds the working
invariants; `PROGRESS.md` is the checkpoint log. Status: complete and audited (three
review passes, 109 tests) but **never run against live traffic** — every adapter was
verified on recorded fixtures only.

## Commands

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build        # the gate for every change (no CI by design)
pnpm --filter @socialmonitor/pipeline test test/prefilter.test.ts   # one file (unscoped `pipeline` also resolves)
pnpm --filter @socialmonitor/shared test
pnpm --filter @socialmonitor/pipeline dev        # worker; idles harmlessly with no DATABASE_URL
FIXTURE_MODE=1 pnpm --filter @socialmonitor/pipeline dev   # + DATABASE_URL and an active monitor with enabled targets: replays fixtures/*.json through the REAL pipeline (idles without a DB, silent with no monitors)
pnpm --filter web dev                            # Next.js on :3000; shows a setup notice when Supabase is unset
```

Tests are vitest (`test/**/*.test.ts`). Migrations: `packages/db/supabase/migrations/0000N_*.sql`,
applied with `supabase db push` after `supabase link` (see README "Activation").

## Architecture — the parts that span files

**Dispatch.** `pg_cron` runs `enqueue_due_jobs()` every 5 min (SQL in migration 00001,
hardened in 00003) → coarse `(monitorId, source, kind)` messages into pgmq `pipeline_jobs`
(`kind` ∈ fetch | classify | metrics | weekly_summary). Dispatch bookkeeping lives in
`sync_streams` rows named `dispatch/<kind>`. The worker (`packages/pipeline/src/index.ts`
→ `runner.ts`) reads with a 15-min visibility timeout, archives after 5 reads, and
**expands each fetch job into streams via `adapter.streams(monitor, targets)`** (classify,
metrics, and weekly_summary use the fixed stream names `classify`, `metrics_refresh`,
`weekly_summary`), running each stream under a session-scoped advisory lock (`queue.ts`).
Per-target streams are named `<role>/<target uuid>` (`search/`, `account/`, `mentions/`,
`channel/`, `guild/`…), so a target's UUID is its stream identity — which is why targets
are upserted in place, never recreated. Derived streams carry no target and a fixed name
(`comments` in Reddit and YouTube, skipped by backfill).

**Fetch = the cursor contract.** `SourceAdapter.fetch(ctx)` returns
`{ items, nextCursor, cursorMeta?, droppedCount? }` where `nextCursor: null` means
*hold*. `runFetchStream` stores raw items first, then advances only on success.
Typed errors from `packages/shared/src/errors.ts` decide everything: `PerItemError` drop
and continue, `TransientError` hold, `SystemicError` increments the breaker (trips at 3,
alerts, skipped until reset in the UI). `errorFromStatus()` maps HTTP codes. Every adapter
does forward-only first sync (no cursor ⇒ record "now", fetch nothing); history is the
explicit **Backfill** action in `apps/web/app/(app)/monitors/[id]/ops-actions.ts`. Its
`backfill()` function encodes each source's rewind: `backfillCursor()` for date-encodable
scalar cursors (X, Reddit, YouTube, Discord's snowflake) plus a `cursor_meta.channels`
rewrite for Discord, a bounded message-id rewind for Telegram, and a generic fallback that
writes X-shaped `{pending_until, pending_newest}` meta (YouTube uses `pending_until` alone). A new source whose cursor lives in `cursor_meta`
needs its own branch there or backfill is a silent no-op (audit #5).
Incomplete windows (page cap, budget) hold and emit `coverage_gap` — see the
`pending_until`/`pending_newest` pattern in `adapters/x.ts`, the `pending_token`/`pending_newest`
page-token resume in `adapters/playstore.ts`, and per-channel cursor maps in `adapters/discord.ts`.
`hasEventToday` debounces events **per stream** — always pass `stream.stream`, or one source's
gap silences every other's for the day (PR #2 review).

**Classify has no cursor.** `classify/engine.ts` anti-joins `raw_items` against
`item_classifications`; the Anthropic batch is *submitted on one tick and collected on
the next*, with the batch id in the stream's `cursor_meta`. Budget gates first (global
monthly cap pauses classify only, never fetch; the per-monitor daily cap bounds the pull) →
prefilter (free; writes noise rows without tokens) → `buildClassifyPrompt` → batch →
`writeClassification` → `recomputeTheme`. (`SPEC.md` §6 lists prefilter before the budget
check; the code order above is what ships.) Theme rows are
**recomputed from items, never incremented**, so corrections keep counts truthful.
Distinct authors rank themes on the dashboard, in `/ask` (`author_count`), and in the
weekly summary (per-week recount in `summary.ts`); the classifier's dedup shortlist
(`shared/src/dedup.ts`) ranks by `item_count`, the only count `getThemeCandidates` selects.
`SPEC.md` §6 says `author_count` everywhere — change neither side silently.

**Two DB access layers in the web app.** Reads go through `@supabase/supabase-js` under
RLS (`lib/supabase/server.ts` → `requireUser`). Writes that need the service path
(Vault, queue, cursor edits, corrections, `/ask` tools) use `createDb()` (postgres.js,
bypasses RLS) **only after an RLS ownership query has proven the row is the user's**,
and always `sql.end()` in `finally`. `lib/supabase/admin.ts` exports a service-role
`adminClient()` that bypasses RLS and currently has no callers — same ownership-first rule
applies if you use it. Access is gated in two layers that must agree:
`ALLOWED_EMAILS` (session) and the `app_allowlist` table (profile creation, migration
00005).

**Credentials.** `resolveCredentials()` (`adapters/credentials.ts`): Vault row via
`source_credentials` wins, env vars (`ENV_KEYS`) are the bootstrap fallback, `null` means
unconfigured. `FIXTURE_MODE=1` makes every adapter report configured and replay
`packages/pipeline/fixtures/*.json` (one per source, plus `youtube-comments.json`) on its
first run per stream.

## Rules that override defaults

- **Template-first (D22):** missing credentials are a *state*, not an error. `status()`
  never throws; unconfigured streams skip silently. Never write code that requires a
  source credential to exist.
- **Never advance a cursor over unprocessed data.** Hold, or record where to resume, and
  emit an event — silence is the failure mode this project cares about most.
- All limits, budgets, cadences, taxonomy are per-monitor runtime config (`MonitorConfigSchema`
  in `packages/shared/src/monitor-config.ts`) — never constants in adapters.
- **Full column lists on every INSERT** (a re-INSERT omitting a column silently blanks
  it); all datetimes `timestamptz` UTC; every write idempotent via `ON CONFLICT`.
- Prompt discipline: static prefix / `PROMPT_CACHE_MARKER` / data last; `defangPromptMarkers`
  on every scraped string entering any prompt (classifier, summary, `/ask` tool results);
  never render tags in the dedup shortlist; mass-failure guard on every classify run.
- Wire JSON Schemas may use only the supported keyword subset (no `maxItems`, `minimum`,
  `maxLength`…) — enforce bounds in Zod and state them in `description` text.
- Anything rendered with `dangerouslySetInnerHTML` goes through DOMPurify.
- **Extensionless relative imports** inside workspace packages (Turbopack has no
  `.js`→`.ts` alias for `transpilePackages`).
- Verify Anthropic model IDs and API shapes against the `claude-api` skill before writing
  LLM code; the reference docs' IDs are stale. Pricing table lives in `classify/anthropic.ts`
  and an unknown model is priced at the most expensive tier on purpose.
- `DATABASE_URL` must be the Supabase **session** pooler: advisory locks are session-scoped
  and the transaction pooler makes every stream silently "already locked" (probed at
  worker startup as `pooler_misconfigured`).

## Adding a source — every seam that enumerates sources

1. `packages/shared/src/constants.ts`: `SOURCES`, `INTEGRATIONS`, `TARGET_KINDS`,
   `SOURCE_LABELS`, `NO_IMPRESSION_SOURCES` (if the platform has no view counts); and any
   per-source budget, toggle, or limit keys in `packages/shared/src/monitor-config.ts`
   (`budgets.*_per_day`, `toggles.*`, `limits.*` follow the existing pattern).
2. A migration widening the `check` constraints on `targets.source`, `targets.kind`, and
   `source_credentials.source` (see 00006 for the pattern; a credential-less source skips
   the credentials constraint, `INTEGRATIONS`, `ENV_KEYS`, and the Connections card; the DB also allows
   `x_api`, which `INTEGRATIONS` does not — the two lists are not 1:1).
3. `packages/pipeline/src/adapters/<source>.ts` implementing `SourceAdapter`
   (`adapters/types.ts`), registered in `adapters/registry.ts`; env keys in
   `adapters/credentials.ts` `ENV_KEYS` and `.env.example`; fixture file(s) in
   `packages/pipeline/fixtures/`.
4. `apps/web`: a card in `connections/page.tsx` `CARDS` + `INTEGRATION_TO_SOURCE` in
   `connections/actions.ts`; a rewind branch in `ops-actions.ts` `backfill()` (see the
   cursor section); a fixed color slot (`SOURCE_VAR` in `components/charts.tsx` +
   `--series-N` in `globals.css`, light and dark) — validate any palette change with the
   `dataviz` skill's `scripts/validate_palette.js` (it is not in this repo); `serverExternalPackages` in `apps/web/next.config.ts` if the adapter
   pulls a Node-native SDK (the web build statically imports the whole adapter registry
   through `getAdapter`).
5. Tests: parse test in `test/adapters.test.ts` (fixture mode, `sql = null`) and a cursor
   test in `test/adapter-cursors.test.ts` using `test/helpers/fake-sql.ts` (`fakeSql()` +
   `stubFetch()`); README target-kinds table and connections table.

## Testing conventions

- **Cursor tests are the ones that matter, and each must be able to fail.** When you
  change cursor logic, mutation-test: re-introduce the bug, watch the named test fail,
  restore, watch it pass. `test/cursor-contract.test.ts` covers the runner with repos
  mocked; `test/adapter-cursors.test.ts` and `test/telegram-cursor.test.ts` drive real
  adapters against a scripted `fetch` and a fake `sql`.
- Fixture-mode adapter tests pass `null` as the DB to prove no query is made.
- Live-source changes get a shakedown against real credentials when one exists; expect
  field drift versus fixtures (the D22 trade-off).

## Repo facts

GitHub `benlvb/socialmonitor` (public, solo). Web deploys to Vercel with root
`apps/web`; the worker builds from `packages/pipeline/Dockerfile` via root `railway.toml`;
Supabase owns DB, pgmq, pg_cron, Vault, auth. Conventional Commits. Deliberately no CI
workflow — run the three gate commands locally before pushing.
