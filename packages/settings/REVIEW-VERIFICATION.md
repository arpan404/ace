# Review verification

Historical evidence for the previous fix round ending at `94c9534`. This does not validate the current revision. See [verifier follow-up](VERIFIER-FOLLOWUP.md) for containment corrections, current static checks and validation deferred to merge under the owner rule.

Review fixes were developed against the merged `origin/main` (merge commit `78afa40`). Relay and notifications subsequently landed and were merged in `f1a80fe`, preserving both settings and notification wire/lifecycle integration. Before fixes, the new public-service regression suite had 11 failing cases and one passing case. Every blocker reproduced its reported behavior with real files or an injected uncontrollable boundary; the tests then passed after correction. A scalar-offset regression was added with the performance change. Settings/package/daemon coverage now contains 44 tests, including 17 added during this review.

## Regressions

- Duplicate JSONC properties retain the last-good document, report validation errors, block assignment and leave disk unchanged.
- Shadowed API tokens, escaped shadowed provider keys, prototype properties and `passwd` are rejected before materialization; inherited settings cannot become effective.
- A workspace `.ace` symlink cannot change global approvals; replacing the directory with a symlink during a real write is rejected before publication.
- Failed watcher installation remains visible despite valid reads; registration retries and subsequent edits notify subscribers.
- One physical file used by global/workspace layers reports the scope's effective layer provenance.
- One hundred sequential inactive thread reads reuse capacity while an active subscription remains live.
- Scalar edits retain unknown payloads and correctly adjust later offsets after Unicode/length changes; changed external sources still receive full validation.
- Shutdown remains pending until an accepted gated real write commits.
- File and directory durability must complete before atomic writes report success.
- Oversized sparse files reject with a size diagnostic before exceeding an injected bounded allocation boundary.
- Secret tests inspect error messages for rejected contents; the watcher double cannot dispose a replacement watcher.
- The concurrent-write test describes serialization; a separate test proves shutdown draining. The atomic race gate releases in `finally`, including assertion failures.

## Production mutations

All four surviving review mutations were individually applied to production code, produced assertion failures through public APIs and were reverted. They were repeated after the performance changes. Six additional production mutations guard the new fixes. A test-double mutation also confirms replacement-watch coverage. Review mutation 11 was also repeated to verify it fails without hanging cleanup.

| Mutation                                   | Failing behavior                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Review 15: omit shutdown drain             | shutdown stays pending                                                      |
| Review 16: omit file fsync                 | atomic commits wait for file durability                                     |
| Review 17: omit directory fsync            | atomic commits wait for directory durability                                |
| Review 22: omit stat-size allocation guard | oversized sparse documents fail before exhausting bounded allocation        |
| Omit duplicate rejection                   | duplicate JSONC assignments retain last-good state                          |
| Omit decoded property inspection           | shadowed credential fields receive a secret diagnostic                      |
| Omit pre-rename containment callback       | workspace replacement cannot publish globally                               |
| Clear watcher health on successful parsing | watch installation failures remain visible                                  |
| Omit scalar offset adjustment              | cached scalar edits preserve valid persisted Unicode values                 |
| Review 11: rename before race gate         | external edits follow documented last-writer ordering, with clean test exit |

Changing the watcher test double back to its old unconditional disposer also failed the watch-recovery behavior test. This is separate from the production mutations.

The original 14 mutation results remain in [verification](VERIFICATION.md).

## Local gate

Unmodified `bun run check` passed: formatting, lint, all 262 source files within 1,500 lines, workspace typechecks, 78 test files passed and one skipped, 593 tests passed and four skipped. No provider prompts were sent. GitHub CI is disabled and was not run.

## Benchmark

Command: `bun run --filter @ace/settings bench`. Node 26.8.1, macOS arm64. One warmed non-gating run follows. An in-memory filesystem boundary isolates CPU costs and excludes physical fsync/rename latency. Changed external reconciliation replaces the document on every iteration, including preparation of that external source. Scalar rows use 1,000 assignments with 1,023 unrelated subscriptions and one affected subscription. Timing and RSS vary with JIT, garbage collection and host load.

| Operation                                             | Operations |      Ops/s | Microseconds/op | Peak RSS KiB |
| ----------------------------------------------------- | ---------: | ---------: | --------------: | -----------: |
| Cached get                                            |    100,000 |  1,565,416 |            0.64 |      128,816 |
| Assignment, zero subscribers                          |      3,000 |    260,652 |            3.84 |      129,936 |
| Assignment, 1,023 unrelated + one affected subscriber |      3,000 |    270,958 |            3.69 |      131,488 |
| Watcher burst scheduling                              |    100,000 | 19,398,642 |            0.05 |      131,536 |
| Changed external reconciliation, 16 KiB               |      1,000 |     13,870 |           72.10 |      133,136 |
| Existing scalar assignment, 0 KiB unrelated           |      1,000 |    250,039 |            4.00 |      133,392 |
| Existing scalar assignment, 16 KiB unrelated          |      1,000 |    231,506 |            4.32 |      133,600 |
| Existing scalar assignment, 256 KiB unrelated         |      1,000 |     58,279 |           17.16 |      156,192 |
| Existing scalar assignment, 879 KiB unrelated         |      1,000 |     14,975 |           66.78 |      219,200 |

Peak process RSS was 219,200 KiB and 7,002 relevant notifications were delivered. The assignment-row difference includes warmup and is not evidence that subscribers improve throughput. Cached scalar edits reuse validated source and a bounded known-key offset index. Reading, byte validation, string replacement and atomic file replacement still require O(document bytes), capped at 1 MiB. Full parsing remains necessary for changed external documents, insertions, migrations and complex values. Active work, subscriptions and unhealthy last-good files pin the bounded 64-entry LRU; healthy inactive files are evicted.
