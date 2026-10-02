# Forge verification

## Current owner policy

Tests run once at merge. No tests, probes, mutation runs, flakiness runs or benchmarks are executed during this delivery phase. The preceding policy’s in-flight check was stopped when this rule arrived. All execution results below are historical evidence recorded before the rule; current runtime validation **needs run at merge**. Static formatting, lint, size and package typechecks are the available checks; the latest follow-up records their results below.

| Mutation case designed to be caught  | Public behaviour guard                            | Current execution                 |
| ------------------------------------ | ------------------------------------------------- | --------------------------------- |
| N4: remove generation assertion      | Feedback-free paused identical relink rejects     | not executed (tests run at merge) |
| N12: remove location digest fields   | Location-only edit queues fresh file/line context | not executed (tests run at merge) |
| Remove legacy acceptance adoption    | Historical accepted ledger does not replay        | not executed (tests run at merge) |
| Keep old accepted key after adoption | Subsequent location edit queues fresh feedback    | not executed (tests run at merge) |
| Remove legacy candidate alias        | Pending retry retains original executor key       | not executed (tests run at merge) |
| Observe before admission             | Backpressure preserves unadmitted feedback        | not executed (tests run at merge) |
| Remap unchanged page rows            | Unaffected public feedback versions remain stable | not executed (tests run at merge) |
| Drop collection upserts              | Changed feedback appears in pending candidates    | not executed (tests run at merge) |

## Historical evidence (before owner policy)

Run on 2026-10-02 in the feature worktree with Node 26.8.1 on Darwin arm64 using native TypeScript execution. Benchmarks are non-gating; process RSS is the cumulative high-water mark, including the in-memory SQLite benchmark database. The production ledger uses a file database and removes acknowledged payloads.

| Operation                                               |   Samples |      Ops/s |    µs/op | Peak RSS MiB |
| ------------------------------------------------------- | --------: | ---------: | -------: | -----------: |
| check mapping                                           |   100,000 |     16,376 |    61.06 |        107.9 |
| unchanged review index, 2 records                       | 1,000,000 |  2,880,782 |     0.35 |        108.5 |
| unchanged review index, 2000 records                    | 1,000,000 | 18,235,586 |     0.05 |        110.6 |
| metadata-only revision, 2000 unchanged records          |   100,000 |    303,718 |     3.29 |        111.1 |
| one edited comment, 2 current records                   |   100,000 |     70,883 |    14.11 |        111.3 |
| one edited comment, 2000 current records                |   100,000 |     90,125 |     11.1 |        112.3 |
| unversioned full input, 2 records                       |     1,000 |    699,158 |     1.43 |        112.3 |
| unversioned full input, 2000 records                    |     1,000 |        149 |  6707.76 |        129.4 |
| streaming tail, 50KB chunk                              |     2,000 |         69 | 14555.27 |        129.5 |
| SQLite intent admission and acknowledgement             |    10,000 |      1,434 |   697.31 |        243.8 |
| SQLite duplicate lookup with 10000 delivered identities |   100,000 |     69,131 |    14.47 |        247.5 |
| warm status, 2 comments, 1 conditional pages            |     2,000 |      7,532 |   132.77 |        113.1 |
| warm status, 2000 comments, 20 conditional pages        |     2,000 |      1,218 |   820.91 |        118.2 |
| one edited page, 2 comments, 1 conditional pages        |     2,000 |        955 |  1046.58 |        136.9 |
| one edited page, 100 comments, 1 conditional pages      |     2,000 |        123 |  8134.77 |        222.6 |
| one edited page, 2000 comments, 20 conditional pages    |     2,000 |         89 | 11271.24 |        222.7 |

`bun run --filter @ace/forge bench` runs both workloads. These final observations were made under shared-machine load above 270; elapsed measurements include scheduler contention. RSS is cumulative per process; status uses a separate injected-runner process. No subprocess/network throughput claim is implied.

Versioned one-comment edits take 14.11/11.10 µs with 2/2,000 current comments: candidate work depends on the changed feedback, not historical record count. An earlier lower-load run of the same candidate design measured 0.72/0.67 µs. REST pages reuse unchanged row projections inside edited pages; GraphQL retains unaffected thread projections. Warm status scales with conditional page requests. Edited-page status includes bounded decoding and O(output) flat immutable array materialization; 100 versus 2,000 comments use the same 100-record edited page, with the latter also polling 19 unchanged pages.

The unversioned compatibility path must compare a caller’s full current input: it has no change metadata. It is explicitly O(input), benchmarks at 1.43/6,707.76 µs under this load, and is not used by GitHubForge’s retained review loop. Logs process incoming bytes and duplicate detection uses SQLite’s index. Weak collection metadata contains opaque predecessor tokens, not owning snapshot chains; row maps retain only current capped records.

## Deliberate mutations

Each mutation was applied to production code alone, killed by the listed behaviour test, and reverted. No mutation remains in the delivered implementation. All twelve exited with a failed Vitest test, rather than a tooling error.

| Mutation                                      | Broken behaviour caught by test                                   |
| --------------------------------------------- | ----------------------------------------------------------------- |
| M1: ignore merged flags                       | Merged PR stays merged even when GitHub also reports closed       |
| M2: report CI failures as success             | Failure outranks pending and successful checks                    |
| M3: report in-progress checks as success      | Running checks remain pending even with a success conclusion      |
| M4: reject cached 304 responses               | ETags reuse unchanged resources while new comments remain visible |
| M5: stop after the first REST page            | Checks and comments on subsequent pages are returned              |
| M6: retain recognised GitHub tokens           | Unknown fields are preserved only after token redaction           |
| M7: double the log ring allocation            | The log tail never exceeds its configured byte cap                |
| M8: delete acknowledged delivery identities   | The same feedback never queues again after restart                |
| M9: ignore server retry deadlines             | Polling waits through the full rate-limit deadline                |
| M10: omit expected merge SHA                  | Merge requests carry the head guard                               |
| M11: ignore inactive review-thread membership | Resolved and outdated feedback never queues                       |
| M12: double the snapshot byte budget          | Oversized paginated snapshots fail visibly                        |

The first review-round repository check passed 447 tests, with four opt-in tests skipped. That round’s 49 forge tests use a temporary executable fake `gh`, synthetic recorded JSON responses, real git repositories, real subprocess cancellation handshakes and temporary SQLite. No coding-provider prompts or recorder sessions were run.

A read-only smoke test through the real logged-in `gh` read ace PR #10 as merged with two successful checks and no review threads. It printed only aggregate status fields. No live mutation calls were made.

## Review regression and mutation evidence

Before production fixes, all ten new public-API regression cases failed: paginated summary-only reviews; stale pending work after merge, close, CI repair, thread resolution, or edited feedback/head replacement; paused unlink/relink to the identical PR; immutable unchanged resource reuse; colliding redacted keys; and generic access-token assignments. After the fixes they all pass. Additional cases cover backpressure on unchanged polls, rebinding rejected unchanged feedback to a new head, persisted generations, dismissed summaries, deterministic overlap rejection, current-only review-index updates, and changed-only watcher publication. The watcher regression also failed before its publication fix.

The review's four surviving mutations were each reproduced against the old assertions (exit 0), then rerun with the strengthened assertions (exit 1 with a failed Vitest test). All eight mutations below were applied separately to production code and reverted; each failed a behaviour assertion, not compilation or a timer budget.

| Mutation                                              | Behaviour test that fails                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Wrong auto-merge SHA                                  | Full auto-merge argv carries the expected head SHA                       |
| Wrong auto-merge method                               | Full auto-merge argv carries the requested squash method                 |
| Wrong auto-merge PR number                            | Full auto-merge argv carries PR 7                                        |
| Remove both MCP link writes                           | Starting unlinked, link/create persist through file-backed SQLite reopen |
| Omit submitted review projection                      | Paginated summary-only reviews enqueue their actionable bodies           |
| Remove pending head invalidation                      | Rejected unchanged review text rebinds to the current head               |
| Stop advancing link generations                       | A paused unlink/relink read rejects before delivery                      |
| Reuse cached content despite a changed representation | Changed comment text becomes visible without mutating the old snapshot   |

No mutation remains in the delivered code. The final repository check includes the strengthened tests and all regression cases. No provider prompts or recorder sessions were run.

After merging remote access from `origin/main` (`844e0eb`), default-concurrency checks encountered five-second timeouts under shared-machine load (load average above 180). `VITEST_MAX_WORKERS=2 bun run check` limits process fan-out without changing assertions, synchronization or test deadlines; the combined suite has 447 passing tests and four opt-in skips.

## Independent-verifier fixes

Before their fixes, the historical file-SQLite ledger replayed both accepted intents; a one-page edit replaced untouched feedback versions; and resolving one thread replaced the other thread’s immutable projection. All now pass through the public API. Additional tests cover mixed legacy/current accepted or pending identities, original executor-key retry, feedback-free paused unlink/relink, location-only edits and oversized review states. Forge now has 58 passing tests.

Eight separately applied production mutations each failed a behaviour assertion (no timeout or tooling failure) and were reverted:

| Mutation                                   | Behaviour caught                                          |
| ------------------------------------------ | --------------------------------------------------------- |
| N4: disable early generation assertion     | Feedback-free paused read rejects across identical relink |
| N12: omit file/line from digest            | Location-only edit queues fresh file/line context         |
| Disable legacy acceptance adoption         | Original acknowledged ledger does not replay              |
| Keep adopted legacy acceptance key         | Later location edit produces a fresh intent               |
| Drop legacy CI candidate alias             | Pending retry retains original executor identity          |
| Observe before durable admission           | Backpressure preserves unadmitted feedback                |
| Remap unchanged records within edited page | Unaffected feedback retains its public version            |
| Drop changed-comment collection upserts    | Edited feedback appears in current pending candidates     |

Under load above 230, unchanged pre-round head `2749697` also hit the default five-second fake-process timeout in the same worktree; the original bytes were restored afterward. Forge fake-process tests now use a 60-second completion safeguard, independent of the production child deadline. No unrelated package deadlines or assertions were changed. Tests use completion handshakes, not sleep synchronization. CI is disabled by the repository owner; no CI run, rerun or wait was requested this round.

## Final merged-worktree checks under load

After merging main through `19a7e14`, formatting, lint, size (387 files), and every package typecheck passed. The complete repository test run had 929 passes, four opt-in skips and ten completion timeouts across seven unchanged files. All 58 forge tests passed separately after that merge (11 files, 144.59 seconds under load). A second full `bun run check` attempt encountered unchanged baseline timeouts and was stopped when the owner’s new rule arrived. Historical repository execution was not green; current runtime validation is deferred to merge. No CI operation was requested.

The baseline was an archive of `origin/main` inside this worktree, with its own offline-installed dependencies. Its source files and all core/git/notification/daemon production sources are unchanged by this PR. The archive was removed after verification. Default completion deadlines were left intact:

| Branch timeout                                   | Main reproduction                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Notification disk spool (5 seconds)              | Same test timed out twice on main                                                      |
| Core silent-child deltas (5 seconds)             | Same test timed out on main                                                            |
| Git dirty submodule checkpoint (30 seconds)      | Same test timed out on main; also passed another main retry, demonstrating variability |
| Daemon foreground lifecycle CLI (15 seconds)     | Same test timed out on main                                                            |
| Two Tailscale CLI cases (5 seconds)              | Both timed out on main                                                                 |
| Daemon restart after SIGTERM / crash (5 seconds) | Both timed out on main                                                                 |
| Global pairing budget (5 seconds)                | Same test timed out on main and branch retries                                         |
| Revoked-device ticket-cap case (5 seconds)       | Passed on both main and branch retries; no source or assertion change                  |

Load ranged above 220–360 during these runs. Every repository failure in the completed first run was a completion timeout, not a behaviour assertion. This evidence establishes unrelated baseline/load failures rather than a forge regression; it does not claim a green repository gate. Logs were retained in `/tmp/ace-forge-final-check.log`, `/tmp/ace-forge-main-{load,remote,lifecycle,retry,boundaries-full}.log`, and `/tmp/ace-forge-after-merge.log`. No unrelated code or test deadline was changed.

## Static verifier follow-up

The owner proxy approved the B3/R2 bounded page-processing departure. ADR 0016 records the actual costs and caps, including full current collection materialization and GraphQL traversal. No implementation restructuring is required by that decision.

The missing legacy pending-review location guard is now written in `upgrade-regressions.test.ts`, using a pre-generation file-SQLite fixture and the public `ReviewLoop.poll` API. File-only, line-only and combined edits keep the body, timestamp and head unchanged. Each case expects only the current review context, a fresh executor key, an empty pending outbox and no repeat delivery on the next poll.

Mutation F9, removing `legacyChanged` from pending discard conditions, is intended to fail this exact-context guard because the old alias still resolves when only its location changes. Ignoring either file or line during stale legacy comparison is also covered by the separate cases. All three mutation cases: not executed (tests run at merge). Their runtime results need run at merge.

The follow-up merged main through `5494e21` without rebasing. Permitted static checks passed: formatting, lint, all 17 package typechecks, and size for all 425 source files. No integration-rehearsal comment was present on PR #20 when checked. No test, probe, benchmark, mutation or CI operation was executed for this follow-up.
