# Release workstream verification

The repo owner changed worker policy during this task: final verification is static only. Tests, probes, benchmarks and mutations are not executed under that policy. All final runtime claims **need run at merge**. Earlier evidence below is historical and does not validate the final recovery, supervisor and native-staging changes.

## Static review

- The service package exposes plans, an injected service-manager runner, streaming artifact verification, maintenance admission, SQLite snapshots and a journaled updater through its package export.
- Node 24.13.0 and JS dependencies are pinned. Archives use sorted paths, fixed metadata and the pinned gzip implementation. macOS stages node-pty and its helper; Linux stages a checksum-pinned PTY produced on the target host.
- Release authority is an embedded Ed25519 public key. Signature verification precedes downloads; archive length and SHA-256 verification precede extraction. Private signing keys must remain outside the repository.
- Downloads, feed bodies, archives, extraction entries and logs have bounds. Maintenance command admission is constant-time and allocation-free. Blocker queries use a partial SQLite index and do not replay transcripts.
- Update intent is durable before service stop. Only a completely synced snapshot is marked restorable. Migration checks use copies; journaled startup closes admission. Rollback validates the exact recorded inventory and integrity before deleting live databases and syncs restored files before removing the journal.
- Atomic pointer replacement uses a same-directory symlink rename. Launchers resolve the generation once for both Node and JavaScript. Current and previous generations are retained.
- Installation, update and uninstall share an OS-backed SQLite mutex. Uninstall preserves databases and configuration. Service tests use owned fake executables; no real user service is operated.
- Local maintenance requires the host token; remote HTTP listeners do not expose it. Approval answers and explicit stop commands remain admitted during drain.

Fast static checks: formatting, lint, package typechecking and source-size checks passed. Latest origin/main, including remote access, relay, model persistence, automations, Conductor and process-suite fixtures, was merged without rebasing. The new automations workspace required its local protocol/provider-kit dependency links before static typechecking.

## Behaviour tests awaiting merge

Each item needs run at merge.

- Generated plist semantics include login startup, restart throttling, paths and escaped environment.
- Generated user-unit semantics include login startup, restart policy and systemd path escaping.
- Repeated install/uninstall converges under real owned fake launchctl/systemctl processes.
- Manager failures surface instead of becoming an inactive status.
- Validated daemon settings survive service installation; provider credential variables are excluded.
- Invalid Ed25519 signatures are rejected before download or service changes.
- Invalid archive checksums are rejected before stop or pointer changes.
- A healthy update exposes the complete candidate and retains the previous generation.
- Racing readers observe complete immutable generations across pointer swaps.
- Failed candidate health restores executable, original values and original database schema.
- Whole-thread working, waiting, approval and unresponsive states block updates, including archived threads.
- Unapproved active work refuses restart and releases admission; approved drain waits for natural completion.
- WebSocket work commands are blocked during maintenance while approval replies still settle existing work.
- Journaled startup begins with admission closed.
- Failed migration checks leave the old generation and live database unchanged.
- SQLite snapshots include uncheckpointed WAL changes.
- Interrupted swaps recover the previous pointer and data; unsafe recovery paths are refused.
- Interrupted snapshots restart the old generation without restoring partial files.
- Missing or corrupt snapshots are rejected before live databases are deleted.
- A failed stop acknowledgement leaves recoverable intent and restarts the old generation.
- A competing updater cannot mutate files; killing the lock owner allows a new updater.
- Oversized responses and archives are refused; archive links cannot escape staging.
- Streamed hashes match content; logs retain only two capped generations with backpressure.
- The standalone bundle starts its persistence workers and answers authenticated status without a checkout.
- The POSIX installer accepts authentic artifacts and rejects independent checksum/signature corruption.
- Linux staging accepts checked PTYs without a macOS-only helper and rejects changed native inputs.

## Mutation cases

Every final case is marked **not executed (tests run at merge)** in `results.json`:

1. Disable login startup.
2. Remove launchd restart throttling.
3. Disable systemd crash restart.
4. Bypass manifest signature verification.
5. Bypass archive checksum verification.
6. Bypass the active-tree restart barrier.
7. Roll back the pointer to the candidate.
8. Skip the migration dry run.
9. Leave maintenance command admission open.
10. Restore an incomplete snapshot as though it were complete.
11. Validate snapshots only after deleting live databases.
12. Journal intent only after stopping the service.
13. Require the macOS spawn helper in Linux artifacts.
14. Bypass native-input checksum verification.

Nine mutations were executed and caught before the owner changed the policy. Their sources were restored. The execution harness has been removed; the final case manifest retains their historical outcomes separately from merge-time status.

## Historical evidence before the policy change

- A focused 28-test feature run passed; a later 12-test update/mutex run passed. These preceded the final prepared-journal and Linux-staging fixes.
- The earlier full check did not pass: 898 passed, four skipped and 11 failed. Ten failures were timeouts on the loaded shared host; one exact status expectation lacked the new version field. That expectation was corrected. Git, core and notification timeout cases passed in isolation with larger hang limits. The replacement full run was interrupted when the owner prohibited test execution; no final full-suite pass is claimed.
- The macOS arm64 artifact opened a real owned shell PTY, started the daemon and persistence workers in an isolated data directory, answered authenticated status and shut down. The final artifact needs run at merge on all four targets.
- Two Node 24.13.0 macOS arm64 builds produced the same 39,729,182-byte archive and SHA-256 `74615ddde63c000e54c82f1d7b897aa756b44b7bbe23bc6c7025664fa4e84c32`. Final runtime changes supersede that artifact; final reproducibility needs run at merge.
- Non-gating measurements on the shared host at load about 199: streaming SHA-256 18.37 MiB/s, bounded log writes 69.00 MiB/s, admission 279.36 million operations/s, combined benchmark process peak RSS 168.84 MiB. Final measurements need run at merge; they are not performance gates.

## Release prerequisites and limits

The first published release needs an approved public key, privately held signing authority, checksum-pinned Linux native inputs and published assets reachable by the HTTPS installer/updater. This PR does not publish a production release or invent a signing authority. The current default feed assumes public GitHub release assets; private-only distribution needs a separate authenticated publication/access policy.

The target matrix is macOS arm64/x64 and glibc Linux arm64/x64. Musl and Windows are outside the brief. Preview labels at the same numeric version follow numeric and dot-separated prerelease precedence. Homebrew installs the artifact and prints the managed-service command rather than starting user services during brew installation. Autonomous engines must consult the exposed maintenance gate before starting new turns. These integration requirements are recorded in ADR 0041.

## Review follow-up

The review of head 1745f1e was read with `gh pr view 48 --comments`. There was no comment titled "Integration rehearsal: findings for this PR" at delivery. All follow-up verification is static; regression execution and mutation kills need run at merge.

1. Incomplete snapshots previously passed when only present files were valid. The new snapshotted journal requires the original database inventory returned from the source enumeration, persisted after backup fsync and before migration/start. Restoration checks exact membership and integrity before deletion. Public `recoverUpdate` tests remove all snapshot files or only models.sqlite and assert both live databases, candidate pointer and recovery intent remain intact. A positive empty-original test permits removal of databases introduced by the candidate. These regressions document the old failure path; they were not executed.
2. An asynchronous spawn error previously left a referenced interval and open logs. Public `runSupervisor` injects daemon/updater spawners, scheduling and signal subscriptions. Central finally cleanup cancels timers, removes listeners and closes both output streams. A real outer Node process injects an asynchronous EAGAIN spawn error and must close both logs, report failure and terminate. This regression was not executed.
3. The initial recovery child previously failed while the original updater held the SQLite mutex and was never retried under manual policy. Pending recovery now schedules bounded exponential retries independently of daily updates. A controlled real-process/SQLite regression observes initial lock contention, kills the transaction owner, advances the injected timer and asserts recovery restores original values/pointer and removes the journal. The committed variant removes the journal before killing the owner and still requires admission release without rolling back committed data. Linux systemd-run waits for the actual transient-unit result rather than treating successful submission as completed recovery. No sleeps or wall-clock assertions are used. These regressions were not executed.
4. Reinstall now stops/re-registers only changed service plans. Fake managers validate platform commands, registration domains and unit/plist files, then expose the loaded configuration. New tests assert changed PATH/ports reach the running service.
5. Preview ordering compares numeric identifiers as integers and follows dot-separated prerelease precedence. Cases include preview.2 after .1, .10 after .2, equality, rollback refusal, label ordering and values above floating-point precision.
6. Supervisor diagnostic files use bounded sinks, with launchd stdout/stderr redirected to /dev/null. An owned bundled-process regression starts with oversized diagnostic files, fails before daemon launch, then checks process termination and both file generations against their caps.
7. Log rotation and backpressure are separate tests. The latter fills the writable high-water mark, observes refusal/drain and verifies accepted bytes reach disk. The bundle test authenticates over WebSocket and verifies notification-device data persisted through the notification worker. A drain deadline test advances an injected clock while blockers remain and asserts no restart plus admission release. The unsafe-journal regression now supplies a valid prepared stage, so schema changes cannot mask its intended path-traversal mutation.

All nineteen mutations from the review map to intended assertions in results.json, alongside the new blockers and coverage fixes. Every final case is not executed (tests run at merge). No new benchmark or dynamic-check result is claimed. Existing numbers remain historical. Recovery retains at most one retry timer, one daily timer and one updater launcher; attempt state is capped at six, delay at 60 seconds, and database inventory at 32 entries. The new work is proportional to that bounded inventory or a lifecycle event, never to agent history.

### Final main integration

GitHub reported conflicts after the review response because diagnostics, forge, workspace, Claude adapter and audit fixes landed on main. Merged main again without rebasing. Preserved the diagnostics doctor/support-bundle CLI alongside managed services, structured logging, queue counters and the maintenance gate. Read-only diagnostics remain available while admission for agent work is closed; a public socket regression checks the returned measurement and unchanged event sequence.

The release bundle now includes the diagnostics log worker, thread export worker and SQLite helper process, rewriting their URLs to artifact-local modules. PTY probing is anchored to the bundled daemon module. The standalone artifact regression additionally asserts the persisted listening log, SQLite integrity report and exported thread-created event from the support-bundle CLI, using an empty owned PATH so it cannot discover provider executables. These runtime behaviours and the four additional mutation cases **need run at merge**; they were not executed. No new hot path was introduced in this integration: fixed build entries and module URL routing are packaging work.

Final static verification after this integration: formatting, lint, all workspace typechecks and size checks passed. All 642 source files are below the 1,500-line hard limit. Dependency links/cached package copies were refreshed locally for static resolution without running installation hooks, native builds, tests, probes or benchmarks.
