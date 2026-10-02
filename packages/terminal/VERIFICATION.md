# Verifier follow-up

The repository owner now permits static checks only during development. Tests run at merge. No test, mutation, benchmark, Docker harness or probe is executed after that instruction. Runtime conclusions about the final head **need run at merge**.

## Changes reviewed statically

- R1: every selected job group gets a fresh ownership read before its signal. A preceding signal cannot leave another group's old inventory entry trusted through the rest of the sweep.
- R2: a stop/kill sweep completes before checking the deadline for repeating sweeps. Shutdown freezes the original shell PID separately, leaving the FIFO keeper runnable. Failure resumes paused groups after revalidation; the private lease permits resuming the original group when inventory is unavailable. Remaining ownership is retained for a retry.
- R2: failed terminal and manager close promises are cleared. Separate flags keep admission and writes closed, while successful promises remain shared and idempotent.
- R3: process cleanup and exit decoding have separate outcomes. Successful backend cleanup permits release even when `exited` retains its decoding rejection. Release frees the ring and removes the manager's handle.
- Load-sensitive tests: only terminal tests receive larger hang guards. Existing output/process synchronization and memory assertions stay in place. Other packages' test code and global Vitest settings are unchanged.

Ring append, UTF-8 alignment and attachment delivery are unchanged. New process inventories are confined to signaling and cleanup, outside the output hot path. The final throughput, allocation bounds and loaded shutdown behavior need run at merge.

## Behavior tests and intended mutations

All tests use the public manager/backend API. Controlled ports model inventory and scheduling interleavings; the keeper test uses a real PTY and daemon process.

| Test behavior                                                                     | Mutation case                                                              | Status                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| A recycled job group remains foreign and running between TERM signals             | Omit per-group ownership revalidation                                      | not executed (tests run at merge) |
| Inventory can recover and manager shutdown can be retried                         | Cache a failed manager close promise forever                               | not executed (tests run at merge) |
| Inventory can recover and manager shutdown can be retried                         | Cache a failed terminal close promise forever                              | not executed (tests run at merge) |
| Malformed exit still rejects lifecycle but permits releasing stopped history      | Await the rejected exit promise as a cleanup prerequisite                  | not executed (tests run at merge) |
| Malformed exit still rejects lifecycle but permits releasing stopped history      | Require a decoded exit status before releasing the ring                    | not executed (tests run at merge) |
| Inventory failure after STOP resumes surviving owned processes before retry       | Omit SIGCONT recovery for paused job groups                                | not executed (tests run at merge) |
| A slow inventory finishes killing the reserved group after its jobs               | Apply the repeated-sweep deadline before finishing the reserved-group kill | not executed (tests run at merge) |
| Daemon death while its shell is frozen leaves the keeper able to consume FIFO EOF | STOP the entire reserved group, including the keeper                       | not executed (tests run at merge) |

The real keeper test registers cleanup for its child daemon and shell group, terminates the daemon at an explicit inventory barrier and observes the keeper's process state. It uses no sleep for synchronization and no elapsed-time assertion.

## Validation limits

An earlier, pre-policy check reported timeouts in unchanged daemon lifecycle, daemon MCP and notification tests. A clean archive of origin/main was prepared for comparison but never executed after the policy changed, and was removed. Baseline equivalence under load remains unproven and needs run at merge. These unrelated tests were not changed.

CI is disabled by the repository owner. No CI run, rerun or watch is requested. No comment titled "Integration rehearsal: findings for this PR" was present when checked. Static checks are recorded in the PR reply.
