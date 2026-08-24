# PROGRESS

## Done
- 2026-08-24: P3 web app: Supabase auth (allowlist), setup-notice when unconfigured, monitors CRUD (targets editor + schema-validated JSON config, import/export via JSON), connections page (Vault-backed secrets, per-integration test buttons, status pills), dashboard v1 (stat tiles, volume-by-source + sentiment charts on validated palette, top themes, pipeline health, events), items page with inline corrections feeding review_verdicts + theme adjustment, weekly summaries page. Build green, 41 tests.
- 2026-08-24: P2 source adapters: x (twitterapi.io, since_time cursor, read budget, metrics refresh), reddit (oauth, 4 streams, depth-1 comments w/ parent context), youtube (channels+budgeted search+comments, quota-aware, stats refresh), telegram (GramJS MTProto, lazy-loaded), discord (REST, snowflakes, forward-only first sync, MESSAGE_CONTENT canary, neighbors/reply-chain context). Vault+env credential resolution, fixture replay through real pipeline. 41 tests green.
- 2026-08-24: P1 pipeline core: queue consumer (pgmq, poison-pill archive, advisory stream locks), job runner with the full cursor/breaker contract, classifier engine (Batch API lifecycle across ticks, prefilter, budgets with hard-cap pause, mass-failure guard, theme merge), Anthropic transport (haiku batch + realtime), Telegram notifier, metrics-refresh runner. 32 tests green.
- 2026-08-24: P0 scaffold complete: pnpm monorepo (shared, db, pipeline, web), initial migration (schema+RLS+pgmq+pg_cron producer), 21 shared tests green, web builds.
- 2026-08-24: Spec interview complete (22 decisions, see SPEC.md §0). SPEC.md + CLAUDE.md written.

## In progress

## Next
- P2 source adapters (x, reddit, youtube, telegram, discord) + metrics refresh
- P3 web (auth, connections, monitor CRUD, dashboard v1, corrections)
- P4 /ask + weekly summary + notifier
- P5 activation (link Supabase, deploy Vercel + Railway, per-source shakedown as credentials arrive)

## Blocked / awaiting user
- Credentials (all placeholder by design): Supabase project, Anthropic key, twitterapi.io,
  Railway account, fresh Telegram bot + channel, Reddit app, YouTube key, spare TG number, Discord bot.
