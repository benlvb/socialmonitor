## What and why

<!-- What changes, and what problem it solves. Link an issue if there is one. -->

## Verification

<!-- Paste the results, don't just tick the boxes. -->

- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm build` green

## If this touches cursor, budget, or credential logic

- [ ] Added or updated a test for the behaviour
- [ ] **Mutation-checked it**: re-introduced the bug, watched the named test
      fail, restored, watched it pass
- [ ] Cursors still never advance over unprocessed data
- [ ] Missing credentials still skip cleanly rather than throwing

## Notes for the reviewer

<!-- Anything you're unsure about, or deliberately left out. -->
