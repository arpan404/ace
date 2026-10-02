# Process test reliability

The `process` Vitest project owns tests that launch real CLIs, child processes,
Node workers or listening sockets. Its per-test and hook deadlines come from
`PROCESS_TEST_TIMEOUT` in the public `@ace/provider-kit/testing` module. Both
projects use two workers and run in sequence, so unit workers do not compete
with integration startup. Unit tests retain Vitest's default five-second budget.

Global setup builds the actual daemon CLI once per invocation, signs one TLS
fixture and initializes one empty Git repository in parallel. Each daemon gets
private TLS files; each Git test copies the empty repository and creates its own
real commit. Restart and crash tests still spawn separate Node daemon processes.
The remote restart test still generates and persists an identity through the
production path. MCP, notify and the model catalog remain external to the bundle because MCP
has runtime-relative UMD requires and the other two resolve workers relative
to their modules. The temporary fixtures are removed at teardown and on setup failure.

Readiness comes from CLI stdout, IPC, socket open/listening/close and request
completion. No test runs `bun install`, and no spawn performs a build. The only
readiness polling is for orphan process groups and connection refusal after
owner exit, where there is no child-process event to await; these loops yield
with `setImmediate` and share the scheduling deadline. Short timers that test
actual timeout, heartbeat, backoff or forced-kill behavior remain short.

The EPIPE peer now announces closed stdin from the final Node executable, after
the shell exec transition. Its earlier shell notification preceded that transition
and hung once under load despite a two-minute runner allowance. The fixed fixture
passed `--repeats 30` with 16 CPU burners before the owner changed the validation policy.

The core's 10,000-delta scenario retains every delta and output assertion. It
folds the outputs incrementally and checks complete client/state parity at the
final tick, avoiding 10,000 copies of history and whole-view comparisons.
Notify's real 10,001-thread SQLite capacity test also shares the integration
project's budget. Its volume must exceed the production spool limit, so reducing
that volume would remove the behavior it guards.

## Audit of main

The audit followed calls through test helpers and production entry points,
including OpenSSL signing, provider discovery, GitService, NotificationWorker,
MCP harnesses, daemon socket/remote fixtures and relay peers. The branch's starting
main commit was `709f66d`. Its 56 real-edge suites below are selected by
`scripts/process-test-suites.ts`; mixed suites stay together. The SQLite capacity
suite `packages/notify/src/review.test.ts` adds one integration workload, bringing
the project's total on this branch to 57 files.

Main advanced to `19a7e14` during verification. Static inspection of that commit
found six more suites with real workers, processes or servers. The manifest
already includes them for merge, bringing the merged project's expected total
to 63 files. The model catalog stays external to the CLI bundle so its SQLite
worker resolves beside the real source. That merged behavior needs run at merge.

| Test file                                               | Real edge                                                 |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `apps/daemon/src/auth.server.test.ts`                   | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/client-limits.test.ts`                 | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/device-creation.server.test.ts`        | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/items-window.test.ts`                  | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/lifecycle.test.ts`                     | Daemon/CLI processes and sockets                          |
| `apps/daemon/src/mcp.test.ts`                           | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/notification-race.test.ts`             | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/notifications.remote.test.ts`          | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/notifications.server.test.ts`          | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/ownership.server.test.ts`              | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/payloads.test.ts`                      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/pressure.test.ts`                      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/remote-boundaries.server.test.ts`      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/remote-cli.test.ts`                    | Daemon/CLI processes and sockets                          |
| `apps/daemon/src/remote-payloads.test.ts`               | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/remote.server.test.ts`                 | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/server.test.ts`                        | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/subscription.test.ts`                  | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/text-storage.test.ts`                  | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/ticket-allocation.server.test.ts`      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/relay/src/abuse.test.ts`                          | Real WebSocket relay and peers                            |
| `apps/relay/src/availability.test.ts`                   | Real WebSocket relay and peers                            |
| `apps/relay/src/relay.test.ts`                          | Real WebSocket relay and peers                            |
| `apps/relay/src/throttling.test.ts`                     | Real WebSocket relay and peers                            |
| `apps/relay/src/validation.test.ts`                     | Real WebSocket relay and peers                            |
| `packages/adapter-testkit/src/cli.test.ts`              | Bun workspace command and real Node CLI processes         |
| `packages/git/src/checkpoints.test.ts`                  | Real Git processes and temporary repositories             |
| `packages/git/src/diff-resources.test.ts`               | Real Git processes and temporary repositories             |
| `packages/git/src/diff.test.ts`                         | Real Git processes and temporary repositories             |
| `packages/git/src/lifecycle.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/git/src/malformed.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/git/src/nested.test.ts`                       | Real Git processes and temporary repositories             |
| `packages/git/src/numbering.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/git/src/process-runtime.test.ts`              | Real Git processes and temporary repositories             |
| `packages/git/src/repository.test.ts`                   | Real Git processes and temporary repositories             |
| `packages/git/src/review-regressions.test.ts`           | Real Git processes and temporary repositories             |
| `packages/git/src/worktrees.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/mcp-server/src/admission.test.ts`             | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/discovery-apis.test.ts`        | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/discovery-fifo.test.ts`        | mkfifo process                                            |
| `packages/mcp-server/src/http-boundaries.test.ts`       | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/http.test.ts`                  | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/lifetime.test.ts`              | Real HTTP/MCP server and clients                          |
| `packages/notify/src/apns.test.ts`                      | HTTP/2 server                                             |
| `packages/notify/src/ipc.test.ts`                       | Real Node notification worker                             |
| `packages/notify/src/webpush.test.ts`                   | HTTP server                                               |
| `packages/notify/src/worker.test.ts`                    | Real Node notification worker                             |
| `packages/orchestrator/src/git-boundary.test.ts`        | Real Git processes and temporary repositories             |
| `packages/orchestrator/src/git.test.ts`                 | Real Git processes and temporary repositories             |
| `packages/provider-kit/src/discovery/discovery.test.ts` | Real Node/shell processes; discovery also uses a TCP gate |
| `packages/provider-kit/src/jsonrpc.test.ts`             | Real Node/shell processes; discovery also uses a TCP gate |
| `packages/provider-kit/src/live.test.ts`                | Opt-in installed CLI handshakes and local server          |
| `packages/provider-kit/src/process.test.ts`             | Real Node/shell processes; discovery also uses a TCP gate |
| `packages/provider-kit/src/sse-recovery.test.ts`        | Real HTTP/SSE server                                      |
| `packages/provider-kit/src/sse.test.ts`                 | Real HTTP/SSE server                                      |
| `tools/recorder/src/stdio.test.ts`                      | Synthetic Node CLI processes; no subscription use         |

The additional suites from `19a7e14` are:

| Test file                               | Real edge                                                          |
| --------------------------------------- | ------------------------------------------------------------------ |
| `apps/daemon/src/models.server.test.ts` | HTTP/WebSocket servers, private TLS files and model SQLite workers |
| `packages/models/src/catalog.test.ts`   | Model SQLite workers and restart persistence                       |
| `packages/models/src/discover.test.ts`  | Real Node CLI processes and model SQLite workers                   |
| `packages/models/src/review.test.ts`    | Real Node CLI processes and model SQLite workers                   |
| `packages/models/src/storage.test.ts`   | Model SQLite workers                                               |
| `packages/models/src/streaming.test.ts` | Real Node CLI processes                                            |

The live-provider suite remains opt-in through `ACE_LIVE_CLI=1`. Ordinary runs
skip it and use controlled stand-ins; the recorder itself is never invoked.
Other tests in the requested directories use pure logic, schema parsing,
filesystem/SQLite fixtures or injected process boundaries without starting a
real process or listening server. Future real-I/O suites should join the manifest.

## Validation record

The owner now requires tests to run only at merge. No tests, benchmarks,
mutation runs, runtime probes or `bun run check` are permitted during this work.
The earlier request for three loaded runs and the full local gate is superseded.
Runtime reliability of the final branch needs run at merge.

Before that policy change, the initial main run with 16 owned `yes` processes
reproduced all three reported failures, plus daemon remote/MCP and Git timeout
failures. It was interrupted after capturing those failures. Later loaded runs
exposed the bulk SQLite/delta limits and the EPIPE readiness race described above.
After those fixes, one complete loaded run passed: 105 files passed, one skipped;
824 tests passed, four opt-in live-provider tests skipped. Vitest reported 607.47
seconds, with load average 262 at startup. The second run exited with code 1
because a Vitest worker received SIGTERM while running Git lifecycle tests. Its
log reported 104 files and 822 tests passed, four skipped tests, and one runner
error. The source of that signal is undetermined from static review. No third
run started, and no three-run proof or full `bun run check` gate is claimed.
The controller, Vitest workers and owned CPU burners were absent when work
resumed under the new rule.

Final verification uses static review. `bun run fmt`, `bun run lint`,
`bun run typecheck` and `bun run check:size` passed on this branch.
Runtime claims remain needs run at merge.

## Behavior assertions and mutation cases

These existing behavior tests retain their assertions after the fixture changes.
The mutation cases below describe what those assertions are intended to reject;
every case is **not executed (tests run at merge)**.

| Behavior test                                                                    | Mutation case                                                                                          | Status                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Daemon prevents a second process sharing the database and restarts after SIGTERM | Remove exclusive ownership, fail graceful release, or prevent the new process from accepting clients   | not executed (tests run at merge) |
| Daemon releases the instance lock after a crash and preserves committed events   | Keep the dead owner's lock or lose an acknowledged persisted event                                     | not executed (tests run at merge) |
| Remote CLI binds the address discovered from a real Tailscale status process     | Ignore the discovered address or bind the wrong remote endpoint                                        | not executed (tests run at merge) |
| Remote CLI exposes a redeemable QR URL, device listing and revocation            | Issue an unusable pairing URL, omit the redeemed device, or accept a revoked credential                | not executed (tests run at merge) |
| JSON-RPC rejects pending requests on EPIPE while the peer is still alive         | Swallow the pipe error, leave pending requests unresolved, or report only peer exit                    | not executed (tests run at merge) |
| Model catalog persisted models are available before discovery after restart      | Break worker startup or lose the durable model cache                                                   | not executed (tests run at merge) |
| Core root deltas do not re-derive a silent child's status                        | Drop or alter deltas, emit child status updates during root traffic, or lose final client/state parity | not executed (tests run at merge) |
| Git snapshots preserve index bytes, HEAD, branch refs and stash bytes            | Mutate the user's index or refs while capturing a checkpoint                                           | not executed (tests run at merge) |
| Notification spool retains its capacity behavior with 10,001 threads             | Allow unbounded spool growth or discard the wrong thread's notification                                | not executed (tests run at merge) |

The static review checks that readiness still precedes each dependent operation,
that fixture copies remain private, that tests retain real process/server edges,
and that short timers for timeout behavior remain unchanged. These checks do not
establish runtime success; that needs run at merge.

[Vitest worker limits](https://vitest.dev/config/maxworkers) and
[project group order](https://vitest.dev/config/sequence#sequence-grouporder)
make the concurrency cap independent of the host's advertised CPU count.
