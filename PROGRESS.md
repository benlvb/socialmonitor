# PROGRESS

## Done
- 2026-08-24: P0 scaffold complete: pnpm monorepo (shared, db, pipeline, web), initial migration (schema+RLS+pgmq+pg_cron producer), 21 shared tests green, web builds.
- 2026-08-24: Spec interview complete (22 decisions, see SPEC.md §0). SPEC.md + CLAUDE.md written.

## In progress
- P1 pipeline core (job runner, cursors/breakers, classifier, themes, budgets, guards)

## Next
- P2 source adapters (x, reddit, youtube, telegram, discord) + metrics refresh
- P3 web (auth, connections, monitor CRUD, dashboard v1, corrections)
- P4 /ask + weekly summary + notifier
- P5 activation (link Supabase, deploy Vercel + Railway, per-source shakedown as credentials arrive)

## Blocked / awaiting user
- Credentials (all placeholder by design): Supabase project, Anthropic key, twitterapi.io,
  Railway account, fresh Telegram bot + channel, Reddit app, YouTube key, spare TG number, Discord bot.
