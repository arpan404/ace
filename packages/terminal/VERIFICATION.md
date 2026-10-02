# Verifier follow-up

The repository owner now permits static checks only during development. Tests run at merge. No test, mutation, benchmark, Docker harness or probe is executed after that instruction. Runtime conclusions about the final head **need run at merge**.

## Changes reviewed statically

- R1: every selected job group gets a fresh ownership read before its signal and a same-session kernel pin before numeric signaling. A preceding signal cannot leave another group's old inventory entry trusted through the rest of the sweep.
- R2: a stop/kill sweep completes before checking the deadline for repeating sweeps. Shutdown freezes the original shell PID separately, leaving the FIFO keeper runnable. Failure resumes pinned job groups without discovery and attempts every recovery target; the private lease permits resuming the original group when inventory is unavailable. Remaining ownership is retained for a retry.
- R2: failed terminal and manager close promises are cleared. Separate flags keep admission and writes closed, while successful promises remain shared and idempotent.
- R3: process cleanup and exit decoding have separate outcomes. Successful backend cleanup permits release even when `exited` retains its decoding rejection. Release frees the ring and removes the manager's handle.
- Load-sensitive tests: real PTY suites join main's shared process-test project with 120-second hang guards. Existing output/process synchronization and memory assertions stay in place. Other packages' test code and global Vitest settings are unchanged.

Ring append, UTF-8 alignment and attachment delivery are unchanged. New process inventories are confined to signaling and cleanup, outside the output hot path. The final throughput, allocation bounds and loaded shutdown behavior need run at merge.

## Behavior tests and intended mutations

All tests use the public manager/backend API. Controlled ports model inventory and scheduling interleavings; the keeper test uses a real PTY and daemon process.

| Test behavior                                                                     | Mutation case                                                              | Status                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| A recycled job group remains foreign and running between TERM signals             | Bypass revalidation and kernel-owned signaling                             | not executed (tests run at merge) |
| Inventory can recover and manager shutdown can be retried                         | Cache a failed manager close promise forever                               | not executed (tests run at merge) |
| Inventory can recover and manager shutdown can be retried                         | Cache a failed terminal close promise forever                              | not executed (tests run at merge) |
| Malformed exit still rejects lifecycle but permits releasing stopped history      | Await the rejected exit promise as a cleanup prerequisite                  | not executed (tests run at merge) |
| Malformed exit still rejects lifecycle but permits releasing stopped history      | Require a decoded exit status before releasing the ring                    | not executed (tests run at merge) |
| Inventory failure after STOP resumes surviving owned processes before retry       | Omit SIGCONT recovery for paused job groups                                | not executed (tests run at merge) |
| A slow inventory finishes killing the reserved group after its jobs               | Apply the repeated-sweep deadline before finishing the reserved-group kill | not executed (tests run at merge) |
| Daemon death while its shell is frozen leaves the keeper able to consume FIFO EOF | STOP the entire reserved group, including the keeper                       | not executed (tests run at merge) |

The real keeper test registers cleanup for its child daemon, shell group and background job, terminates the daemon at an explicit inventory barrier after STOP and requires the shell, keeper and job groups to contain no live process before cleanup. It uses no sleep for synchronization and no elapsed-time assertion.

## Validation limits

An earlier, pre-policy check reported timeouts in unchanged daemon lifecycle, daemon MCP and notification tests. A clean archive of origin/main was prepared for comparison but never executed after the policy changed, and was removed. Baseline equivalence under load remains unproven and needs run at merge. These unrelated tests were not changed.

CI is disabled by the repository owner. No CI run, rerun or watch is requested. No comment titled "Integration rehearsal: findings for this PR" was present when checked. Static checks are recorded in the PR reply.

## Second verifier follow-up

S1 is addressed at the I/O boundary with a package-owned POSIX C keeper. A child in the PTY session joins a selected group using setpgid, which rejects foreign-session membership atomically; it then stays alive to reserve the group ID across signals. Guardians close the lifetime FIFO reader so they cannot falsely prove that the original keeper still exists. The keeper never trusts an inventory's owner string to authorize a secondary signal. The boundary-only stale-snapshot test returns old ownership while actual rows become foreign just before the final read resolves. A separate real-PTY test forges foreign ownership in discovery and requires the foreign process to answer ping after TERM, using the production keeper.

S2 recovery uses those pins even while discovery keeps failing. Every selected STOP target is retained before acknowledgment, all recovery targets are attempted, and failures remain available for retry. S3 EOF handling kills pinned groups, discovers and pins other current same-session groups, and kills the original shell group last. The death test freezes a TERM/HUP-ignoring shell and its background job, then requires every recorded owned group to stop before registered cleanup runs.

Additional cheap coverage checks native-spawn lease disposal, acquisition failure with repeated cleanup, and another terminal stopping despite an unavailable inventory. None of these tests was executed. No compile command or keeper executable was run under the static-only policy; C compilation and both POSIX platforms need run at merge. Install postinstall will compile the keeper with the existing native toolchain. No new third-party dependency was added.

| Behavior                                                                 | Mutation case                                                       | Status                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------- |
| Final-read recycling leaves a foreign job running                        | Replace kernel-pinned secondary signaling with raw numeric kill     | not executed (tests run at merge) |
| Forged foreign ownership still leaves a real process responsive          | Accept a foreign-session setpgid failure or bypass the keeper       | not executed (tests run at merge) |
| Persistent discovery failure resumes all paused jobs                     | Read inventories as a prerequisite to failure-path resume           | not executed (tests run at merge) |
| A lost STOP reply still resumes the stopped job                          | Record recovery only after successful acknowledgment                | not executed (tests run at merge) |
| Daemon death stops shell, keeper and background groups                   | Exit only the keeper on FIFO EOF or omit job/original-group cleanup | not executed (tests run at merge) |
| Native spawn failure disposes its ownership lease                        | Omit disposal after native spawn throws                             | not executed (tests run at merge) |
| Fixture acquisition failure removes its workspace and cleanup can repeat | Omit acquisition cleanup or break repeated cleanup                  | not executed (tests run at merge) |
| Another terminal stops despite an unavailable inventory                  | Stop manager shutdown after its first rejection                     | not executed (tests run at merge) |

Main advanced through `50c725f`, including shared process-test scheduling and readiness improvements. It was merged, not rebased. Terminal real-I/O suites now join that shared project instead of overriding its guards locally. This resolves the configuration mismatch statically; load reliability and the previously reported unrelated timeouts still need run at merge. No flaky-baseline equivalence is claimed.

Explicit SIGSTOP also pauses the original shell separately, keeping the keeper runnable. A public behavior guard checks shell/job pause, keeper progress and successful subsequent cleanup. Mutation: send reserved-group SIGSTOP instead of pausing its shell PID. Status: **not executed (tests run at merge)**.

A second real daemon-death test uses the default backend end to end, awaits public SIGSTOP, kills its daemon and requires both original and pinned job groups to stop. It guards the default native shell-pause path as well as the keeper's EOF cleanup. Runtime result needs run at merge. Removing only inventory revalidation is now redundant for secondary signaling because kernel pins independently enforce membership; the older mutation case is updated to bypass both checks.
