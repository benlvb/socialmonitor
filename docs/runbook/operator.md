# Operator runbook — running socialmonitor day to day

## What this is
socialmonitor watches social platforms for whatever your monitors define (accounts,
keywords, communities), LLM-classifies every item, and turns the stream into themes,
dashboards, weekly summaries, and Telegram alerts. You operate it almost entirely from
the web app; the worker and cron run themselves.

## Daily operation
1. **Telegram channel first** — if nothing alerted, the pipeline is healthy. Alerts fire
   only for: `breaker_tripped`, `budget_paused`, `mass_failure`,
   `canary_message_content`, `summary_failed`, `summary_truncated`, and any error-level
   event.
2. **Dashboard per monitor** (`/monitors/<id>`): scan the four tiles (items·7d,
   relevant rate, budget burn, spend) and the Pipeline health table. Cursor age
   ("last success") is the liveness signal per stream.
3. **Correct a few classifications** (`/monitors/<id>/items`): open anything mislabeled →
   **Fix classification** → say *why* in the note. Corrections are the tuning loop — each
   becomes a few-shot example on the very next classify tick. A new monitor typically
   needs 10–20 corrections in week one, then settles.
4. **Ask questions** (`/monitors/<id>/ask`) instead of eyeballing tables: it reads the
   same data and cites counts with links.

## When things go wrong (top 5)
| Failure | Signal | Response |
|---|---|---|
| Stream breaker tripped | `breaker` pill + Telegram alert | Cause is in the event message (revoked key, deleted channel, kicked bot). Fix it, then in Supabase SQL editor: `update sync_streams set breaker_tripped_at=null, consecutive_failures=0 where monitor_id='…' and stream='…';` |
| Monthly LLM cap hit | `budget_paused` alert; /ask answers with a cap message | Deliberate stop (D13). Fetching continued. Raise `GLOBAL_MONTHLY_LLM_CAP_USD` on Railway+Vercel or wait for month rollover; the backlog classifies itself. |
| Discord silently dead | `canary_message_content` alert | Discord dev portal → Bot → re-enable MESSAGE_CONTENT intent. No data was ever acknowledged as read: cursors held. |
| Classify batches produce nothing | `mass_failure` alert | Almost always the Anthropic key (expired/rate-limited) or a schema change mid-flight. Railway logs name the batch id. |
| Worker down | Cursor ages grow everywhere; `pgmq.metrics('pipeline_jobs')` queue length climbs | Railway → service → restart. Jobs are idempotent; the backlog drains itself. Nothing needs replaying. |

## Safe vs. not safe
- **Always safe:** restarting the worker; re-running anything (all writes are idempotent
  upserts); pausing a monitor (`status: paused`); editing budgets/cadences/taxonomy.
- **Think first:** deleting a monitor (cascades its targets/verdicts/summaries);
  resetting a breaker without fixing the cause (it will re-trip and re-alert);
  hand-editing `sync_streams.cursor` (can skip or refetch data — refetch is harmless,
  skipping is forever).
- **Never:** put secrets in monitor config JSON; share the service-role key.

## Where things live
- Secrets: Supabase Vault via Connections page (rows in `source_credentials`), or env
  vars on Railway (worker) / Vercel (web) — referenced by NAME in `.env.example`.
- Spend: `llm_usage` table; surfaced on the dashboard tiles.
- Audit trail: `pipeline_events` table; last 15 shown per monitor dashboard.
- Weekly summaries: `weekly_summaries` + `/monitors/<id>/summaries` + Telegram.
