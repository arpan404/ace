---
name: fix-failing-tests
description: Find and fix failing tests or a red CI run. Use when the person says tests fail, CI is red, or asks to make the test suite pass.
---

# Fix failing tests

1. Call `ace_context` with `topics: ["notes", "prs", "changes"]`. Project notes often say how tests run here (for example "use `bun run test`, never `bun test`"). Follow them. `prs` shows whether CI on a linked pull request is failing.
2. Reproduce the failure first, running only the failing test files rather than the whole suite. Read the first real error, not the last line.
3. Find the cause before you change anything. Decide whether the code or the test is wrong. Never weaken an assertion just to make it pass.
4. Make the smallest fix, then rerun the same tests, then their neighbours.
5. If several unrelated failures need fixing, you may hand independent ones to children with `delegate_task` (one task each), then collect them with `ace_wait`.
6. If you learned how this project's tests must be run, save it with `ace_note_add` so the next thread doesn't relearn it.
