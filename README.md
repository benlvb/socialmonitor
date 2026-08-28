# socialmonitor

Configurable multi-source social monitoring. You define **monitors** — which platforms,
which accounts, which keywords, and your own taxonomy — and the pipeline fetches matching
content, classifies it with an LLM into a universal signal schema, dedupes it into
**themes**, and surfaces everything through a dashboard, an **/ask** chat analyst, weekly
AI summaries, and Telegram alerts.

Built **template-first**: the entire system runs with zero credentials. Every integration
is optional; plugging a key in activates that piece on the pipeline's next tick — no
deploy, no code change.

- Spec / design decisions: [SPEC.md](./SPEC.md) · Progress: [PROGRESS.md](./PROGRESS.md)
- Deeper runbooks: [docs/runbook/operator.md](./docs/runbook/operator.md) ·
  [docs/runbook/engineer.md](./docs/runbook/engineer.md)
- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md) · Security:
  [SECURITY.md](./SECURITY.md) · Licence: [MIT](./LICENSE)

## Status — read this before you rely on it

The system is **complete but not yet battle-tested against live traffic.** All
five sources, the classifier, the dashboard, `/ask`, and weekly summaries are
built; the suite is green (78 tests, including mutation-verified cursor tests);
three review passes (one automated, two full-repo model audits) have been
applied. What has *not* happened is a production run: the adapters were
verified against recorded fixtures and each platform's documented behaviour,
not against real API traffic.

Practically, that means: expect field drift and rate-limit surprises on each
source's first live ticks, and watch the Pipeline health panel while you bring
one credential online at a time. Nothing is lost when an adapter misbehaves —
cursors hold rather than skip — but you should be present for it.

There is no hosted version. You run your own.

## How it works

```
  X · Reddit · YouTube · Telegram · Discord        (any subset, per monitor)
        │ fetch (cursored, budgeted)
        ▼
  raw_items ──► LLM classifier ──► themes (deduped, ranked by unique authors)
  (Supabase)    (Haiku, Batch API,      │
                 prefilter, budgets)    ├─► dashboard (volume, sentiment, themes, health)
                                        ├─► /ask chat (digest + read-only tools)
  pg_cron ► pgmq queue ► worker         ├─► weekly summary (Sonnet, Monday) ─► Telegram
  (Supabase)            (Railway)       └─► alerts (breakers, budgets, canaries) ─► Telegram
```

| Piece | Runs on | Package |
|---|---|---|
| Web app (dashboard, /ask, config) | Vercel (or anywhere Next.js runs) | `apps/web` |
| Pipeline worker | Railway (or any Docker host) | `packages/pipeline` |
| Database, queue, cron, secrets vault, auth | Supabase | `packages/db` |

## Requirements

- Node ≥ 20 (developed on 22/23), pnpm 10 (`corepack enable`)
- A Supabase project (free tier is fine) — the only account the *app itself* needs
- Everything else (Anthropic, source APIs, Telegram bot) is optional until you want that
  feature live

## Quickstart (no accounts at all)

```sh
git clone https://github.com/benlvb/socialmonitor && cd socialmonitor
pnpm install
pnpm typecheck && pnpm test && pnpm build   # 41 tests, all packages
cp .env.example .env                        # everything blank is a valid state
pnpm --filter @socialmonitor/pipeline dev   # worker starts, reports "idle (unconfigured)"
pnpm --filter web dev                       # http://localhost:3000 shows the setup notice
```

That proves the code runs. To see the real product you need step 1 below (Supabase);
to see it **full of data without any social-media or LLM account**, add `FIXTURE_MODE=1`
(step 3).

## Activation — step by step

Each step is independent. Stop at any point; everything done so far keeps working.

### 1. Supabase (the backbone)

1. Create a project at [supabase.com](https://supabase.com) → note the project ref
2. Apply the migrations — five files, applied in order
   (`00001` schema + RLS + pgmq queue + pg_cron producer · `00002` dashboard aggregate
   functions · `00003` partition RLS + producer hardening + event scoping ·
   `00004` classification-call accounting · `00005` signup allowlist):
   ```sh
   cd packages/db
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
3. Dashboard → Authentication: enable the **Email** provider, and **turn OFF public
   sign-ups** once your own account exists.

   **Access is gated in two layers and they must agree:**

   | Layer | What it gates | Where you set it |
   |---|---|---|
   | `ALLOWED_EMAILS` (env) | Whether a signed-in session may use the web app at all — checked in `proxy.ts`, `requireUser`, and `/api/ask` | Vercel env var (comma-separated) |
   | `app_allowlist` (table) | Whether a profile row is created at signup — no profile means the `monitors.owner_id` FK cannot be satisfied, so the account cannot create anything even through the raw API | `insert into app_allowlist (email) values ('...');` in the SQL editor |

   The **first** account to sign up bootstraps itself and seeds `app_allowlist`
   automatically; every later address must be inserted there first. If an address is in
   one layer but not the other it will authenticate but be unable to work — add it to
   both.
4. Fill `.env` (Dashboard → Settings → API / Database):
   ```
   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL        → Project URL
   SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY → anon public key
   SUPABASE_SERVICE_ROLE_KEY                      → service role key (server-only)
   DATABASE_URL                                   → "Session pooler" string (NOT the
                                                     transaction pooler on :6543 — the
                                                     worker's advisory locks are
                                                     session-scoped and silently stop
                                                     working there; it probes this at
                                                     startup and logs pooler_misconfigured)
   ALLOWED_EMAILS                                 → your email (comma-separated list)
   ```
5. `pnpm --filter web dev` → sign **up** with an allowlisted email → you're in.

### 2. Anthropic (classification, /ask, summaries)

`ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com).
Defaults: Haiku 4.5 via the Batch API (50% price) for classification, Sonnet 5 for /ask
and weekly summaries. Spend is tracked per monitor in `llm_usage`;
`GLOBAL_MONTHLY_LLM_CAP_USD` (default **$50**) hard-pauses all LLM spend — classification,
/ask, summaries — while **fetching always continues**, so no data is ever lost to a
budget stop.

### 3. See it working end-to-end (fixtures, still no source accounts)

```sh
FIXTURE_MODE=1 pnpm --filter @socialmonitor/pipeline dev
```

With Supabase configured and a monitor created (see below), fixture payloads for all five
platforms flow through the **real** pipeline — fetch → classify → themes — and populate
the dashboard and /ask. Without an Anthropic key a deterministic stub classifier is used;
with one, real classification runs on the fixtures.

### 4. Deploy

**Web → Vercel**: import the repo, set **Root Directory = `apps/web`**, add the env vars
from steps 1–2 plus `TELEGRAM_NOTIFY_*` when you have them.

**Worker → Railway**: new service → Deploy from GitHub repo. The root `railway.toml`
points the build at `packages/pipeline/Dockerfile`. Env vars: `DATABASE_URL`,
`ANTHROPIC_API_KEY`, `WORKER_CONCURRENCY=2`, `GLOBAL_MONTHLY_LLM_CAP_USD=50`, plus
source credentials as they arrive. The worker idles harmlessly when unconfigured.

### 5. Source credentials (any order, any subset)

Enter them on the **Connections** page (stored in Supabase Vault, "Test connection"
button per integration) or as env vars — Vault wins when both exist.

| Source | Get the credential | Env vars |
|---|---|---|
| **X / Twitter** | [twitterapi.io](https://twitterapi.io) → API key (pay-as-you-go scraper; the official X API can replace it later as an adapter swap) | `TWITTERAPI_IO_KEY` |
| **Reddit** | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → create app, type **script** → client id + secret, plus that account's username/password | `REDDIT_CLIENT_ID` `REDDIT_CLIENT_SECRET` `REDDIT_USERNAME` `REDDIT_PASSWORD` |
| **YouTube** | Google Cloud Console → enable **YouTube Data API v3** → API key. Free 10k units/day; keyword search costs 100/query and is budgeted per monitor | `YOUTUBE_API_KEY` |
| **Telegram** | A **dedicated account on a spare number** (never your personal one). Get `api_id`/`api_hash` at [my.telegram.org](https://my.telegram.org), then run the session generator: `TELEGRAM_MTPROTO_API_ID=… TELEGRAM_MTPROTO_API_HASH=… pnpm --filter @socialmonitor/pipeline exec tsx ../../scripts/telegram-session.ts`. One session string = one consumer: don't run two worker replicas on it (Telegram invalidates duplicated sessions). | `TELEGRAM_MTPROTO_API_ID` `TELEGRAM_MTPROTO_API_HASH` `TELEGRAM_MTPROTO_SESSION` |
| **Discord** | [discord.com/developers](https://discord.com/developers/applications) → bot → enable the **MESSAGE_CONTENT** privileged intent → invite to your server with channel-level view permissions | `DISCORD_BOT_TOKEN` |
| **Alerts** | BotFather → `/newbot` (a fresh bot). Add it to a private channel/group, post once, read the chat id from `https://api.telegram.org/bot<token>/getUpdates` | `TELEGRAM_NOTIFY_BOT_TOKEN` `TELEGRAM_NOTIFY_CHAT_ID` |

## Your first monitor

**App → New monitor** — pick a starter template (Brand watch / Competitor watch /
Topic watch) or Blank; templates pre-fill taxonomy, noise rules, and seed examples
with [BRACKETED] placeholders to edit. Then on the settings page:

**Targets** — what to watch, per platform:

| Source | Target kinds |
|---|---|
| x | `keyword` (search phrase, X query syntax works), `account` (handle, no @) |
| reddit | `subreddit`, `keyword`, `user` |
| youtube | `channel` (@handle or UC… id), `keyword` |
| telegram | `channel` (public username) |
| discord | `guild` (server id — bot must be in it) |

**Configuration JSON** — the classifier's brain. Every field is runtime-editable; the
pipeline picks changes up on its next tick. The editor shows the fully-defaulted config;
the fields that matter most:

```jsonc
{
  // 1. WHAT THIS MONITOR IS ABOUT — goes into every classifier prompt. Be specific.
  "context": "Monitoring public sentiment about Acme Widget, a dashboard SaaS. ...",

  // 2. Signal types (edit freely — it's config, not a schema)
  "signal_types": ["complaint","feature_request","question","praise",
                   "announcement","news","opinion","noise"],

  // 3. Your taxonomy. ONE tag is the normal answer; hints prevent misuse.
  "tags": [
    { "name": "Mobile UX", "hint": "the phone app experience specifically" },
    { "name": "Pricing" },
    { "name": "General", "hint": "LAST RESORT ONLY - never alongside another tag." }
  ],

  // 4. What counts as noise FOR THIS MONITOR (markdown, goes into the prompt)
  "noise_rules": "- Posts about the unrelated Acme rocket division\n- Engagement-farming giveaways",

  // 5. Worked examples — the single highest-leverage field. Start with ~5;
  //    every inline correction you make later adds to these automatically.
  "seed_examples": [
    { "text": "widget app crashes on open", "relevant": true,
      "signal_type": "complaint", "tags": ["Mobile UX"], "why": "specific bug report" },
    { "text": "wen acme token 10x", "relevant": false, "why": "price talk, not product signal" }
  ],

  "budgets":  { "daily_classifications": 500, "youtube_searches_per_day": 20, "x_reads_per_day": 2000 },
  "cadence_minutes": { "fetch": 30, "classify": 30, "metrics": 15 },
  "toggles":  { "youtube_videos": true, "youtube_comments": true, "reddit_comments": true,
                "transcripts": false,   // reserved (v2) — not implemented yet
                "ask_tool_approval": false },
  "prefilter": { "min_chars": 8, "mute_patterns": ["giveaway"] },  // free filters before any LLM call
  "model": {}   // per-monitor overrides, e.g. {"classify": "claude-sonnet-5"}
}
```

Copy the JSON out to export a monitor; paste to import. Save → the cron producer picks it
up within ~5 minutes — or hit **Run now** on the dashboard to skip the wait. To pull
history for a fresh monitor, use **Backfill** on the settings page (deliberate,
idempotent, budget-respecting). Per source: X / Reddit / YouTube rewind by date and walk
forward a page per run; Discord rewinds every channel it has already synced; Telegram
rewinds a bounded number of messages from its current position and is skipped before its
first sync. Watch the dashboard's **Pipeline health** panel.

## Day to day

- **Dashboard** — volume by source, sentiment trend, top themes ranked by *unique
  authors* (not raw item count), LLM budget burn, per-stream health. Reddit/Discord have
  no view counts; reach is shown as a labeled engagement/followers proxy, never silently
  mixed with real impressions.
- **Items** — every classified item with the model's reasoning. **Fix classification** on
  any wrong call: the correction rewrites the item, adjusts themes, *and becomes a
  few-shot example that teaches the classifier* — this is how a new monitor gets accurate.
- **/ask** — "what changed this week?", "top complaints about the mobile app", "show me
  the items behind the login theme". Tool calls are shown inline; the optional
  `ask_tool_approval` toggle makes each one require your approval first.
- **Summaries** — every Monday per monitor: at-a-glance, week-over-week table, key themes
  with links, recommendations. Stored, rendered in the app, pushed to Telegram.
- **Alerts** (Telegram): breaker trips, budget cap hits, mass classification failures,
  the Discord MESSAGE_CONTENT canary, summary failures.

## Troubleshooting

| Symptom | Meaning | Do |
|---|---|---|
| Source pill ⚪ awaiting credentials | No key found (Vault or env) | Add on Connections, hit **Test connection** |
| Stream shows `breaker` | N consecutive systemic failures (bad key, deleted channel, kicked bot) | Fix the cause, then hit **Reset** next to the breaker pill in Pipeline health (clears it and retries immediately) |
| `budget_paused` alert | Monthly LLM cap reached | Raise `GLOBAL_MONTHLY_LLM_CAP_USD` or wait; fetching continued, nothing was lost |
| `canary_message_content` alert | Discord returns messages with empty content — the MESSAGE_CONTENT intent was lost | Re-enable the intent in the Discord developer portal |
| `mass_failure` alert | A classify batch processed items but classified zero | Check ANTHROPIC_API_KEY validity and the worker logs |
| Items fetched but never classified | No Anthropic key, daily budget spent, or a batch is still processing (30-min cadence) | Dashboard budget tile + worker logs show which |
| `coverage_gap` warning | More content in one window than the page cap allows; the cursor held and the remainder resumes next run | Nothing lost. If it persists, raise `limits.max_pages_per_fetch` or shorten `cadence_minutes.fetch` |
| `pooler_misconfigured` error | `DATABASE_URL` is the transaction pooler; advisory locks cannot work | Switch to the **Session pooler** string and restart the worker |
| `summary_truncated` / `summary_failed` | The weekly narrative hit the token cap, or the job threw | Truncated: the stored summary may end mid-sentence — re-run happens next Monday, or clear its `weekly_summaries` row to regenerate. Failed: the dispatch marker is cleared automatically so the producer retries |
| `batch_lost` warning | A pending classification batch became unrecoverable (expired after ~29 days, or a 404) | Self-healing — the id is cleared and the items resubmit on the next tick. Only investigate if it repeats |
| `job_poisoned` error | A queue job failed ~6 times and was archived | The message names the monitor and source; check the worker logs for the underlying throw |
| `partition_maintenance_failed` error | Monthly partition creation failed (usually a row in `raw_items_default` colliding with the new range) | The producer keeps running (it no longer aborts). Find the offending row: `select * from raw_items_default order by posted_at desc limit 5;` |
| Nothing happens after saving a monitor | Producer runs every 5 min; worker may be down | **Run now** on the dashboard; if still nothing: Railway logs; `select * from pgmq.metrics('pipeline_jobs');` |

More depth: [docs/runbook/operator.md](./docs/runbook/operator.md).

## Development

```sh
pnpm typecheck · pnpm test · pnpm build      # whole workspace
pnpm --filter @socialmonitor/shared test     # one package
pnpm --filter @socialmonitor/pipeline dev    # worker (FIXTURE_MODE=1 for fixtures)
pnpm --filter web dev                        # web app
```

| Path | What |
|---|---|
| `packages/shared` | Zod schemas (monitor config, classification), constants, pure functions |
| `packages/db` | Migrations (`supabase/migrations/`), postgres.js client |
| `packages/pipeline` | Worker: queue consumer, 5 source adapters, classifier, summaries |
| `apps/web` | Next.js app: auth, connections, monitors, dashboard, /ask |

Architecture rules that matter when extending (cursor contract, error classes, prompt
discipline, how to add a source): [docs/runbook/engineer.md](./docs/runbook/engineer.md)
and [SPEC.md](./SPEC.md).

There is deliberately **no CI workflow** in this repo — run the three commands above
locally before pushing. Add one in your own fork if you want it.

## Responsible use

Monitoring public social content still carries obligations. Respect each platform's terms
of service and rate limits, honour applicable privacy law for any personal data you
collect, and prefer official APIs where you have access. The X adapter ships pointed at a
third-party scraping provider — read their terms and X's before you use it. You are
responsible for how you deploy this.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). The short
version: keep `pnpm typecheck && pnpm test && pnpm build` green, and if you touch cursor
logic, add a test and prove it can fail.

Security problems go through the repository's Security tab, not a public issue — see
[SECURITY.md](./SECURITY.md).

## Licence

[MIT](./LICENSE) — do what you like, no warranty.
