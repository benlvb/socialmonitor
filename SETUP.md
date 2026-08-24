# Activation runbook (P5)

The system is template-first: everything below is optional and independent.
Plug a credential in → that piece activates on the next pipeline tick.
Verify anything end-to-end first with `FIXTURE_MODE=1 pnpm --filter @socialmonitor/pipeline dev`.

## 1. Supabase (the backbone — do this first)

1. Create a project at supabase.com (any region close to you)
2. `supabase link --project-ref <ref>` then `supabase db push` from `packages/db`
   (applies `supabase/migrations/*.sql`: schema, RLS, pgmq queue, pg_cron producer)
3. Fill in `.env` (copy `.env.example`): `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `DATABASE_URL` (use the **session pooler** URI)
4. In Supabase Auth settings, enable email+password. Sign up in the app with an
   email listed in `ALLOWED_EMAILS`.

## 2. Anthropic (activates classification + /ask + weekly summaries)

`ANTHROPIC_API_KEY` from console.anthropic.com. Defaults: Haiku 4.5 via Batch API
for classification, Sonnet 5 for /ask + summaries. `GLOBAL_MONTHLY_LLM_CAP_USD=50`
hard-pauses classification (never fetching) at the cap (D13).

## 3. Web app — Vercel

- Import the GitHub repo; set **Root Directory = `apps/web`**
- Env vars: the Supabase set above + `ANTHROPIC_API_KEY`, `ALLOWED_EMAILS`,
  `DATABASE_URL`, `TELEGRAM_NOTIFY_*` (when ready)

## 4. Worker — Railway

- New service → Deploy from GitHub repo. `railway.toml` at the root points the
  build at `packages/pipeline/Dockerfile`
- Env vars: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `WORKER_CONCURRENCY=2`,
  `GLOBAL_MONTHLY_LLM_CAP_USD=50`, plus source credentials as they arrive
- The worker idles harmlessly when unconfigured; logs show per-tick activity

## 5. Sources (any order, all optional)

| Source | What you need | Where |
|---|---|---|
| X | twitterapi.io API key (pay-as-you-go) | `TWITTERAPI_IO_KEY` or Connections page |
| Reddit | "script" app at reddit.com/prefs/apps + account creds | `REDDIT_*` |
| YouTube | Google Cloud API key, YouTube Data API v3 enabled | `YOUTUBE_API_KEY` |
| Telegram | Dedicated account (spare number) → `scripts/telegram-session.ts` | `TELEGRAM_MTPROTO_*` |
| Discord | Bot with MESSAGE_CONTENT intent, invited with channel perms | `DISCORD_BOT_TOKEN` |

## 6. Alerts (Telegram notifier)

1. BotFather → `/newbot` (fresh bot, D19 — nothing reused)
2. Create a private channel/group, add the bot, get the chat id
   (`https://api.telegram.org/bot<token>/getUpdates` after posting once)
3. `TELEGRAM_NOTIFY_BOT_TOKEN` + `TELEGRAM_NOTIFY_CHAT_ID` — set on **both**
   Railway (worker alerts + weekly summaries) and Vercel (test button)

## 7. First monitor

App → New monitor → add targets (keywords/accounts per source) → fill config
JSON (context, tags with hints, noise rules, a few seed examples — the more
worked examples, the better the classifier). Save; the producer picks it up
within 5 minutes. Watch the dashboard's pipeline-health panel.

## Live shakedown expectation (D22)

Adapters were verified against fixtures + documented API behavior. When a real
credential lands, watch the first few ticks per source for field drift or
rate-limit surprises — pipeline-health + the Telegram channel surface failures.
