# Release workstream verification

The repo owner changed worker policy during this task: final verification is static only. Tests, probes, benchmarks and mutations are not executed under that policy. All final runtime claims **need run at merge**. Earlier evidence below is historical and does not validate the final recovery and native-staging changes.

## Static review

- The service package exposes plans, an injected service-manager runner, streaming artifact verification, maintenance admission, SQLite snapshots and a journaled updater through its package export.
- Node 24.13.0 and JS dependencies are pinned. Archives use sorted paths, fixed metadata and the pinned gzip implementation. macOS stages node-pty and its helper; Linux stages a checksum-pinned PTY produced on the target host.
- Release authority is an embedded Ed25519 public key. Signature verification precedes downloads; archive length and SHA-256 verification precede extraction. Private signing keys must remain outside the repository.
- Downloads, feed bodies, archives, extraction entries and logs have bounds. Maintenance command admission is constant-time and allocation-free. Blocker queries use a partial SQLite index and do not replay transcripts.
- Update intent is durable before service stop. Only a completely synced snapshot is marked restorable. Migration checks use copies; journaled startup closes admission. Rollback validates snapshots before deleting live databases and syncs restored files before removing the journal.
- Atomic pointer replacement uses a same-directory symlink rename. Launchers resolve the generation once for both Node and JavaScript. Current and previous generations are retained.
- Installation, update and uninstall share an OS-backed SQLite mutex. Uninstall preserves databases and configuration. Service tests use owned fake executables; no real user service is operated.
- Local maintenance requires the host token; remote HTTP listeners do not expose it. Approval answers and explicit stop commands remain admitted during drain.

Fast static checks: formatting, lint, package typechecking and source-size checks passed. Main was merged without rebasing; a subsequent fetch found no additional main commits.

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

The target matrix is macOS arm64/x64 and glibc Linux arm64/x64. Musl and Windows are outside the brief. Preview labels at the same numeric version are deliberately not automatically ordered. Homebrew installs the artifact and prints the managed-service command rather than starting user services during brew installation. Autonomous engines must consult the exposed maintenance gate before starting new turns. These integration requirements are recorded in ADR 0041.
