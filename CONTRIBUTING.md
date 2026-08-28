# Contributing

Thanks for looking at socialmonitor. This is a personal project shared in the
hope it's useful; issues and pull requests are welcome, and so is forking it
and going your own way.

## Before you start

Read [SPEC.md](./SPEC.md) — it records 22 design decisions (D1–D22) and *why*
each one was made. Most "why is it built this way?" questions are answered
there, and a change that contradicts a decision needs to argue with it rather
than route around it.

Then read [docs/runbook/engineer.md](./docs/runbook/engineer.md) for the
invariants that matter when you touch the pipeline.

## Getting set up

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

You need **no credentials** to develop or run the test suite. The system is
built template-first: every integration is optional, and unconfigured sources
skip cleanly. `FIXTURE_MODE=1` replays realistic payloads through the real
pipeline. See the README for the full activation path if you want live data.

## The bar for a change

Every PR must keep `pnpm typecheck && pnpm test && pnpm build` green. Beyond
that, four rules carry most of the weight:

1. **Cursor logic needs a cursor test, and the test must be able to fail.**
   The cursor contract is the one place where a bug loses data permanently.
   `test/cursor-contract.test.ts`, `test/adapter-cursors.test.ts`, and
   `test/telegram-cursor.test.ts` exist because two audits found four separate
   ways to silently skip data. When you change this logic, re-introduce the bug
   you're guarding against, watch your test fail, then restore it. A test that
   cannot fail is decoration.
2. **Never advance a cursor over data you did not process.** Hold, or record
   where to resume. If a run ends early, say so with an event — silence is the
   failure mode this project cares most about.
3. **Missing credentials are a valid state, never an error.** `status()` must
   not throw; unconfigured streams skip.
4. **Limits and taxonomy are per-monitor config, not constants.** If you find
   yourself typing a number into an adapter, it probably belongs in
   `MonitorConfig`.

## Adding a source

The adapter contract is `SourceAdapter` in
`packages/pipeline/src/adapters/types.ts`. A new source needs: the adapter,
fixtures replayed in `FIXTURE_MODE`, registry entry, credential keys, a
Connections card, target kinds, and a categorical colour slot. The engineer
runbook has the checklist.

## Style

TypeScript throughout, strict mode, no `any` where a real type will do.
Comments should explain *why* — the code already says what. Conventional
Commits for messages (`fix(scope): summary`).

## Reporting bugs

Use the issue templates. For anything security-related, follow
[SECURITY.md](./SECURITY.md) instead of opening a public issue.
