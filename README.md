# socialmonitor

Configurable multi-source social monitoring: define monitors (platforms + accounts +
keywords + taxonomy) → pipeline fetches and LLM-classifies matching content → deduped
themes → dashboard, `/ask` chat, weekly AI summaries, Telegram alerts.

- Spec / source of truth: [SPEC.md](./SPEC.md)
- Progress: [PROGRESS.md](./PROGRESS.md)
- Built template-first: everything runs with credential placeholders; plug keys into the
  connections page (or `.env`) to activate a source. `FIXTURE_MODE=1` replays realistic
  fixtures through the real pipeline for end-to-end verification without any account.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js app — auth, connections, monitor config, dashboard, /ask, summaries |
| `packages/pipeline` | Worker (Railway) — queue consumer, source adapters, classifier, themes |
| `packages/db` | Supabase migrations + typed query layer |
| `packages/shared` | Zod schemas, constants, pure pipeline functions |

## Develop

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm --filter @socialmonitor/pipeline dev   # worker (FIXTURE_MODE=1 for fixtures)
pnpm --filter web dev                       # web app
```
