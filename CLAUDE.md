# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`socialmonitor` — a configurable multi-source social monitoring system (X, Reddit,
YouTube, Telegram, Discord → LLM classification → themes → dashboard / `/ask` /
weekly summaries / Telegram alerts). **`SPEC.md` is the source of truth** — read it
before designing anything; it encodes ~22 interview-confirmed decisions (D1–D22).
Do not reintroduce ideas from the original reference docs it superseded.

## Rules that override defaults

- **Template-first (D22)**: everything must work with credentials absent — adapters
  report `configured: false` and skip cleanly; never write code that throws on a
  missing source credential.
- All limits/budgets/taxonomy are per-monitor runtime config (Zod `MonitorConfig` in
  `packages/shared`) — never hardcode them.
- Cursor contract: hold on any batch failure; typed errors (PerItem/Transient/Systemic)
  decide cursor behavior; forward-only first sync.
- Full column lists on every INSERT; all datetimes timezoned UTC; idempotent writes.
- Prompts: static prefix / marker / data-last; no tags rendered in dedup shortlists;
  defang user text; mass-failure guard on every classify run.
- Verify Anthropic model IDs/API shapes against the `claude-api` skill before writing
  LLM code — the reference docs' IDs are stale.

## Stack & commands

pnpm monorepo: `apps/web` (Next.js, Vercel), `packages/pipeline` (worker, Railway),
`packages/db` (Supabase migrations + postgres.js), `packages/shared` (Zod schemas).

- `pnpm install` · `pnpm typecheck` · `pnpm test` (vitest; single file:
  `pnpm --filter <pkg> test <file>`) · `pnpm build`
- Worker locally: `pnpm --filter pipeline dev` (`FIXTURE_MODE=1` replays fixtures
  through the real pipeline — the standard way to verify without live accounts)
- Web locally: `pnpm --filter web dev`
- Migrations live in `packages/db/supabase/migrations`; applied via supabase CLI once
  the project is linked (no local Docker on this machine).

GitHub: `benlvb/socialmonitor`. Progress checkpoints in `PROGRESS.md`.
