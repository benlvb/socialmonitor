# Engineer runbook — extending socialmonitor

## What this is
A pnpm monorepo: Next.js web (`apps/web`, Vercel), a queue-consuming worker
(`packages/pipeline`, Railway/Docker), Supabase as database + pgmq queue + pg_cron
producer + Vault + auth. `SPEC.md` records the 23 design decisions (D1–D23); this file is
the working knowledge on top of it.

## Data flow (one sentence each)
1. `pg_cron` runs `enqueue_due_jobs()` every 5 min → coarse `(monitor, source, kind)`
   jobs into pgmq `pipeline_jobs` (cadence per monitor config; dispatch bookkeeping in
   `sync_streams` rows named `dispatch/<kind>`).
2. Worker (`src/index.ts`) reads with a 15-min visibility timeout, poison-pill archives
   after 5 reads, expands each job to streams via the source adapter, single-flights each
   stream with an advisory lock.
3. Fetch (`runner.ts`) obeys the cursor contract; raw items land immediately in
   partitioned `raw_items` with full column lists.
4. Classify (`classify/engine.ts`) is anti-join-driven (no cursor): prefilter → budgets →
   prompt build → Anthropic **Batch** submitted on one tick, collected on the next
   (batch id persisted in stream meta) → `item_classifications` → `mergeTheme`.
5. Web reads under RLS; the service path (corrections, /ask tools, Vault writes) always
   verifies ownership through an RLS query first.

## Invariants — do not break
- **Cursor contract:** hold on any batch failure; `PerItemError` drop-and-continue,
  `TransientError` hold, `SystemicError` increments the breaker (trips at 3). Forward-only
  first sync. Never advance past an unprocessed item.
- **Template-first (D22):** missing credentials are a *state*, not an error. `status()`
  never throws; unconfigured streams skip silently.
- **Prompt discipline:** static prefix / `PROMPT_CACHE_MARKER` / data last; defang
  (`defangPromptMarkers`) every scraped string entering any prompt (classifier, summary,
  /ask tool results); never render tags in the dedup shortlist (measured 79% copy
  contamination in the reference system).
- **Full column lists on every INSERT** (a re-INSERT omitting a column silently blanks
  it); timestamptz UTC everywhere; idempotent upserts.
- **Theme rows are recomputed, never incremented** (`recomputeTheme`): counts stay
  truthful after corrections. Weekly evidence still comes from item-level aggregates
  windowed by `posted_at`; `/ask` labels theme counters "lifetime".
- **Cursors only advance over contiguous coverage.** If a fetch ends early (page cap,
  budget), hold the cursor or record where to resume — never jump to "newest seen", and
  emit `coverage_gap` so it is not silent.
- **A target's UUID is its stream identity** — upsert targets, never delete-and-recreate.
- **Wire JSON Schemas may use only the supported keyword subset** (no `maxItems`,
  `minimum`, `maxLength`…): the schema is attached raw, so nothing strips them. Enforce
  bounds locally in Zod and express them as `description` text.
- **Extensionless relative imports** in packages (Turbopack has no `.js`→`.ts` alias in
  transpiled workspace packages).
- **Sanitize** (`DOMPurify`) anything rendered via `dangerouslySetInnerHTML` — model
  output can echo attacker-controlled scraped content.

## Adding a source
Implement `SourceAdapter` (`adapters/types.ts`): `status`, `testConnection`,
`streams(monitor, targets)`, `fetch(ctx)` (+ optional `refreshMetrics`), throwing the
typed errors. Add fixtures (`fixtures/<source>.json`) replayed on first-run in fixture
mode, register in `adapters/registry.ts`, add env keys to `credentials.ts` ENV_KEYS +
`.env.example` and a card in the Connections page (skip both for a credential-less
source such as `appstore` — `status()` just returns configured), target kinds in
`shared/constants.ts` TARGET_KINDS, a migration widening the `targets` check constraints — and, for a
credentialed source, `source_credentials.source` too (00006 is the pattern; 00007 does both) — and a
categorical color slot in `globals.css`/`charts.tsx` (fixed
order — validate with the `dataviz` skill's `validate_palette.js`).

## Adding an /ask tool
`apps/web/lib/ask-tools.ts`: add the def (name/description/JSON schema) and the case in
`runAskTool` — clamp ints, bind strings, cap rows/chars, defang text fields. The route
loop, gating, and usage recording come for free.

## Infra map
- GitHub `benlvb/socialmonitor` · Vercel root `apps/web` · Railway builds
  `packages/pipeline/Dockerfile` via root `railway.toml` · Supabase owns DB/queue/cron/
  Vault/auth. Migrations in `packages/db/supabase/migrations`, applied with
  `supabase db push` (no local Docker needed).
- LLM: Haiku 4.5 (batch) classify, Sonnet 5 narrate — model strings are config/env
  (`CLASSIFY_MODEL`/`NARRATE_MODEL`), per-monitor overridable. Cost model + cap in
  `classify/anthropic.ts` (`GLOBAL_CAP_USD`).

## Verification
`pnpm typecheck && pnpm test && pnpm build` gates every change. Fixture mode
(`FIXTURE_MODE=1` + a DB) is the end-to-end harness.

**Cursor tests are the ones that matter.** `test/cursor-contract.test.ts` asserts the
runner's hold/advance/breaker decisions with the repo layer mocked;
`test/adapter-cursors.test.ts` and `test/telegram-cursor.test.ts` drive the real adapters
against a scripted `fetch` and a fake `sql` (`test/helpers/fake-sql.ts`) to assert what
each source does with an incomplete window. The fake `sql` records query text and returns
`[]` for anything unstubbed — it never validates SQL, so a malformed query or a wrong
`WHERE` scope passes every test; prove new SQL against a real Postgres (the Supabase
image in Docker applies the whole migration chain). Every one of those cases is a bug an audit
found. When you change cursor logic, **mutation-test your test**: re-introduce the bug,
watch the named test fail, restore, watch it pass. A cursor test that cannot fail is
decoration. Live-source changes get a shakedown
against real credentials (expect field drift vs fixtures — that trade-off is D22).

## Known deferred items (v2 parking lot)
Authors/spikes dashboard · review queue · Slack notifier · official X API adapter ·
channel-drift detection · /ask streaming · transcripts toggle ·
embedding-based cross-source
clustering · multi-tenant signup/billing.
