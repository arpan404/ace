# Verifier follow-up

This follows the independent report on `94c9534`. `origin/main` at `19a7e14` was merged without rebasing in `65aaffc` before these changes. Settings and model-catalog lifecycle/wire additions are both retained. Before delivery, main advanced to `5494e21`; it was merged again in `04a8b39`, retaining automations exports and the upstream process-test reliability work.

The owner changed validation policy during this run. Tests, probes, mutation runs, benchmarks, the aggregate check and GitHub CI are not executed under that policy. Final runtime claims below **need run at merge**. A later owner exception allowed only the three failing daemon files after a merge-time failure; their results are recorded in the final section. Historical observations from before the policy change do not validate the final revision.

## Remaining findings

| Finding                                                    | Correction and public behavior coverage                                                                                                                                                                                                                                                                                                                                                                                                                | Final validation   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| B3 / R1: global-first alias bypasses workspace containment | Workspace acquisition attaches its permanent guard to an already cached physical file. Workspace scopes acquire that layer before global loading, and later global acquisitions find retained guards by the file path even after eviction. Reload, migration and assignment use the retained guard. The global-alias regression retains last-good true, requires a workspace validation diagnostic and verifies the outside v1 file is byte-identical. | Needs run at merge |
| B3 / R2: assignment repins a changed root                  | A bounded workspace-identity registry retains the first canonical root across every operation and physical-file eviction. Assignments cannot override it with a fresh guard. Tests cover both zero and 80 inactive thread reads, then a root replacement aimed at global approvals; global bytes and policy must remain unchanged.                                                                                                                     | Needs run at merge |
| R3: rejected swap leaves a temporary sibling               | Atomic writes retain the original parent handle. Failed-write cleanup finds a renamed sibling directory by device/inode and removes the owned temporary there. The existing gated directory-swap test now also requires `old-ace` to be empty.                                                                                                                                                                                                         | Needs run at merge |
| N14 survivor: missing root-change coverage                 | A workspace root replaced by an empty target must retain its last-good value and the root-change diagnostic. An empty target avoids rejection from another `.ace` symlink check, so this assertion specifically requires pinned root validation.                                                                                                                                                                                                       | Needs run at merge |
| N15 survivor: missing reload/migration coverage            | Protected-workspace tests use outside v1 and v2 documents. Refresh must preserve the old value and outside bytes. The v2 case requires read containment independently of the migration write callback.                                                                                                                                                                                                                                                 | Needs run at merge |
| Full-document assignment CPU work                          | Decode caches the UTF-8 byte count. Scalar updates count only the old raw literal and replacement. The normalized resolution cache contains only the 31 known keys, so copying/freezing does not traverse unknown data. Unknown settings and envelope fields remain in validated source text. Near-cap escaped/unescaped Unicode and repeated unknown-field round-trips have public regressions.                                                       | Needs run at merge |
| Diagnostic fan-out from repeated guarded reads             | Suppress identical document diagnostics. Two unchanged containment failures must produce one subscriber diagnostic.                                                                                                                                                                                                                                                                                                                                    | Needs run at merge |

The identity registry caps at 64 distinct workspace paths for a service lifetime. Unlike the file LRU, it never evicts a successfully pinned identity; silent eviction would permit reauthorization of a replaced root. A public test checks backpressure at the 65th workspace and continued operation of the first. Closing the service releases identities. Thread-only inactive scope reuse remains unchanged.

Temporary recovery inspects at most 128 sibling entries and never follows a replacement symlink to locate the original directory. If the original parent moves outside that directory or beyond the bound, cleanup returns an I/O error. Node's portable filesystem API does not expose directory-relative unlink; this does not promise cleanup after arbitrary concurrent relocation. The reported `.ace` to `old-ace` replacement is covered.

## Behavior tests added or strengthened

All use the exported settings API and real temporary files. Watcher and scheduler boundaries remain injected. No sleeps, elapsed-time assertions or internal-state assertions were added. Execution of the final revision needs run at merge.

- A global alias cannot migrate or read workspace settings through a replaced directory.
- A cold workspace read cannot migrate an aliased global file outside the workspace.
- Global aliases retain workspace containment after physical-file eviction.
- Reloading a protected workspace cannot read or migrate an outside v1 file.
- Reloading a protected workspace cannot read an outside v2 file.
- Assignments cannot repin a moved workspace root before file eviction.
- Assignments cannot repin a moved workspace root after 80 inactive thread reads.
- Workspace identity capacity rejects growth while pinned identities remain usable.
- A root replaced by an empty directory retains its original settings and diagnostic.
- Unchanged containment failures notify subscribers once across repeated reads.
- A rejected directory-swap write leaves the displaced original directory empty.
- Scalar replacements respect UTF-8 capacity with literal Unicode.
- Scalar replacements respect UTF-8 capacity with escaped Unicode.
- Cached scalar writes and later insertion retain many unknown settings and envelope fields.

Before the owner rule arrived, the first alias/root/swap regression run reproduced four failures, and the identity-cap regression also failed before its implementation. After the containment fixes, an intermediate package/daemon-settings run passed 52 tests. The final known-value normalization, schema-inferred cache type and updated unknown-field fixture have not been runtime-validated. These earlier observations do not replace merge-time execution.

## Mutation cases for merge

Every case below is **not executed (tests run at merge)** for the final revision. These are mutations the public assertions are designed to kill, not claimed results.

| Mutation                                                                | Guarding behavior                                                                 | Status                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| N14: remove canonical-root comparison                                   | Empty replacement target retains original value and root-change diagnostic        | not executed (tests run at merge) |
| N15: omit containment before reload                                     | Outside v2 source cannot replace last-good values                                 | not executed (tests run at merge) |
| Skip guard attachment for cached global aliases                         | Global-first alias leaves outside v1 bytes untouched and reports validation       | not executed (tests run at merge) |
| Override the pinned guard with a fresh guard during assignment          | Moved root cannot change global approvals                                         | not executed (tests run at merge) |
| Forget workspace identities when physical files are reclaimed           | Moved-root assignment remains blocked after 80 inactive thread reads              | not executed (tests run at merge) |
| Load a cold aliased global file before installing workspace containment | Cold workspace read leaves outside v1 bytes untouched and uses defaults           | not executed (tests run at merge) |
| Ignore retained workspace guards during global acquisition              | An evicted global alias still blocks outside migration and assignment             | not executed (tests run at merge) |
| Remove the workspace identity cap                                       | A 65th distinct workspace receives limit backpressure                             | not executed (tests run at merge) |
| Omit recovery in the renamed original directory                         | Rejected swap leaves `old-ace` empty                                              | not executed (tests run at merge) |
| Emit identical document diagnostics repeatedly                          | Repeated containment reads deliver one diagnostic                                 | not executed (tests run at merge) |
| Count decoded characters instead of old raw UTF-8 literal bytes         | Escaped/unescaped near-cap scalar replacements preserve the exact byte cap        | not executed (tests run at merge) |
| Remove incremental byte-cap rejection                                   | An oversized scalar assignment rejects without modifying disk or last-good values | not executed (tests run at merge) |
| Rewrite only normalized known settings                                  | Cached edits and insertion retain unknown settings and envelope fields            | not executed (tests run at merge) |

Earlier mutation history remains in [review verification](REVIEW-VERIFICATION.md) and [original verification](VERIFICATION.md). The independent report caught all original survivors; N14 and N15 now have the specific public coverage above. Confirming either new survivor is killed needs run at merge.

## Static checks

Only the permitted checks were run after the owner policy change. Formatting, lint, workspace typechecking and the 1,500-line size check passed. The size check covers 408 source files. Tests, benchmarks and the aggregate `bun run check` were not run after the rule. GitHub CI is disabled and was not requested or watched.

## Historical gate failures

Before the policy change, the full suite on the merged branch encountered multiple five-second harness timeouts under host load. A separate untouched archive of `origin/main` at `19a7e14`, with its own installation, ran the same lifecycle/remote-cli selection concurrently on the same host. Both revisions had six passes and the same three timeout failures:

- `prevents a second process sharing the database and restarts after SIGTERM`;
- lifecycle crash recovery;
- stopped-Tailscale guidance.

This establishes that those three failures also occurred on unmodified main in that comparison. It does not establish a root cause or waive other failures. In particular, the verifier's discovered-address Tailscale case passed on both revisions in that comparison and timed out in another branch run. Other full-suite timeout failures are not claimed as proven baseline failures. No unrelated tests or timeout budgets were changed by the settings fixes. The later merge includes upstream process-test reliability changes from PR #45; their runtime effect also needs run at merge. Current runtime and repository-gate status needs run at merge.

## Performance

Scalar metadata work is bounded by the changed literal and the 31-key schema. Unknown data stays in source text. Resolution visits at most three files; subscriber delivery uses the existing file/key index. Workspace guard retention caps at 64, file-cache and queue bounds remain unchanged, and temporary recovery is bounded to 128 sibling entries.

Reading the file, comparing source text, making the edited string and publishing the atomic replacement still require O(document bytes). The 1 MiB cap bounds those costs. Atomic JSONC replacement must preserve the full source; avoiding redundant parsing, byte scans and unknown-data traversal does not remove the necessary whole-file I/O.

The benchmark source now includes 10,000 unknown keys and native workspace reads, scalar writes with fsync, and rejected-swap recovery. **The final benchmark needs run at merge.** Historical measurements before the final normalized-cache change and before the owner prohibition follow. They ran under substantial host load, are non-gating, and cannot support before/after speedup claims. Units are microseconds per operation and cumulative peak process RSS in KiB.

| Historical workload                                   |      µs/op | Peak RSS KiB |
| ----------------------------------------------------- | ---------: | -----------: |
| Cached global get                                     |      11.09 |      157,360 |
| Assignment, zero subscribers                          |       5.69 |      158,432 |
| Assignment, 1,023 unrelated + one affected subscriber |     122.05 |      160,064 |
| Watcher burst scheduling                              |       1.80 |      160,112 |
| Changed external reconciliation, 16 KiB               |   1,871.49 |      161,584 |
| Scalar assignment, 0 KiB unrelated payload            |      71.72 |      161,760 |
| Scalar assignment, 16 KiB unrelated payload           |      10.20 |      162,160 |
| Scalar assignment, 256 KiB unrelated payload          |     318.69 |      184,016 |
| Scalar assignment, 879 KiB unrelated payload          |   1,479.98 |      244,400 |
| Native cached workspace read with containment         |   7,869.74 |      244,400 |
| Native workspace scalar assignment and fsync          |  93,805.96 |      244,400 |
| Native rejected swap and temporary recovery           | 113,057.70 |      244,400 |

The 10,000-key workload was added after that run. Its measurement and every final-workload result need run at merge. Previous warmer baseline numbers are retained as historical evidence in [review verification](REVIEW-VERIFICATION.md).

## Targeted merge-failure correction

The orchestrator merged main into this branch in `f0b30f5` and reported a failed
merge-time suite. The CLI fixture bundled settings' jsonc-parser, whose relative
CommonJS requires could no longer resolve. Global setup now uses Bun's package
externalization for all package imports. `settings.remote.test.ts` was missing
from the process manifest and could not receive its injected TLS identity; it
now runs with process global setup.

Under the owner's explicit exception, only `settings.remote.test.ts`,
`lifecycle.test.ts` and `remote-cli.test.ts` were executed. The named-file command
reproduced both reported root causes before the fix and passed **3 files / 11
tests** afterward. Their existing public behavior assertions and event barriers
were retained. No full suite, additional test files, benchmarks or mutations ran.
The remaining final-revision runtime validation still needs run at merge.

Formatting, lint and all workspace typechecks passed after the correction.

## Integration merge with daemon audit and workspace services

Merged `origin/main` at `fe670b0` without rebasing. Conflicts were resolved by
retaining both NOTICE entries, all dependencies and the union of process-test
suites. Both settings socket suites run in the process project. Settings cleanup
runs after main's idempotent-cleanup guard. Outbox preserves settings' hard byte
cap while reusing main's serialized-write path and snapshot admission check.
Model requests, notifications, remote authorization and injected delivery runtime
remain unchanged from main. Settings already uses main's `allows` device-scope
API; no local authorization stand-in remains. No PR comment titled
"Integration rehearsal: findings for this PR" was present when checked.

Under the explicit merge-conflict exception, these specific daemon files ran:
settings.server, settings.remote, models.server, server, outbox-work, pressure,
delivery-runtime, notification-shutdown, notifications.server and presence-pressure.
All **10 files / 52 tests passed**. Existing behavior tests cover both sides of
the conflicted server/outbox code. Formatting, lint, all workspace typechecks and
the size check passed, with all **579** sources within 1,500 lines. Dependency
installation rebuilt the workspace descriptor helper successfully.

No full suite, aggregate `bun run check`, Docker tests, benchmark, mutation run or
CI was executed. The full repository runtime gate still needs run at merge.

| Merge mutation case                        | Existing guarding behavior                        | Status                            |
| ------------------------------------------ | ------------------------------------------------- | --------------------------------- |
| Drop settings socket byte admission        | Oversized settings delivery requests reconnect    | not executed (tests run at merge) |
| Drop main's snapshot admission             | Oversized snapshot closes before delivery         | not executed (tests run at merge) |
| Drop main's idempotent cleanup             | Registered presence drains once per session       | not executed (tests run at merge) |
| Drop model handlers from server routing    | Authenticated correlated model requests resolve   | not executed (tests run at merge) |
| Drop settings handlers from server routing | Authenticated settings requests assign and stream | not executed (tests run at merge) |
| Drop shared device-scope checks            | Read-only/operate-only settings permissions hold  | not executed (tests run at merge) |

## Diagnostics and payload/model audit integration

Merged main `46eb036` without rebasing. All seven conflicts retain both sides:
NOTICE paragraphs, daemon dependencies, settings/diagnostics imports and service
ownership, protocol exports, process-suite lists and the regenerated lockfile.
The lockfile started from main, then `bun install` restored the settings entries
and completed the workspace native build. Main's logger, redaction, health
monitor, model catalog, notification worker, MCP and remote services remain wired
alongside settings. Server cleanup cancels settings and releases pending health
after the shared idempotence guard. No local authorization stand-in was needed;
settings keeps using the main device-scope API. No integration rehearsal findings
comment was present in either issue comments or review bodies.

Added a public socket regression proving that a pending health measurement does
not block settings reads, and shutdown frees both health accounting and an
actual settings subscription admission slot. It uses real files and WebSockets,
injected health completion and the existing 1,024-subscription limit, without
sleeps or elapsed-time assertions.

Under the merge-conflict exception, nine daemon files ran: settings.server,
settings.remote, diagnostics.server, lifecycle, models.server,
notification-shutdown, server, pressure and outbox-work. All **9 files / 56 tests
passed**, including the new combined-service regression. Formatting, lint,
workspace typechecks and file-size checks pass across **618** source files.
Full-suite/aggregate-check execution, CI, Docker, benchmarks and mutation runs
remain deferred; the complete runtime gate needs run at merge.

| Integration mutation case                             | Public guarding behavior                                        | Status                            |
| ----------------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| Omit pending health release on cleanup                | Joint settings/health shutdown leaves no pending health request | not executed (tests run at merge) |
| Omit settings subscription disposal on socket cleanup | Joint shutdown restores a settings service admission slot       | not executed (tests run at merge) |
| Block socket processing on the health promise         | Settings read completes while health is still pending           | not executed (tests run at merge) |
| Drop settings or health wire handlers                 | Joint authenticated socket accepts both request families        | not executed (tests run at merge) |

The final fetch also brought core audit `4c2d6fb`. It merged without conflicts; its protocol parsing changes coexist with the additive settings wire variants. Typechecking, lint and the size check passed again after that merge (625 source files). The nine-file/56-test result above predates this final core-only update; execution of the resulting full tree needs run at merge. No further tests or benchmarks were run.
