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
production path. All package imports remain external to the CLI bundle. Node resolves them through
the daemon workspace node_modules, preserving runtime-relative CommonJS requires
and module-relative worker URLs. Only the local CLI modules are bundled. The temporary fixtures are removed at teardown and on setup failure.

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
suite `packages/notify/src/review.process.test.ts` adds one integration workload, bringing
the project's total on this branch to 57 files.

Main advanced to `19a7e14` during verification. Static inspection of that commit
found six more suites with real workers, processes or servers. The manifest
already includes them for merge, bringing the merged project's expected total
to 63 files. The model catalog stays external to the CLI bundle so its SQLite
worker resolves beside the real source. That merged behavior needs run at merge.

| Test file                                                       | Real edge                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/daemon/src/auth.server.process.test.ts`                   | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/client-limits.process.test.ts`                 | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/device-creation.server.process.test.ts`        | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/items-window.process.test.ts`                  | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/lifecycle.process.test.ts`                     | Daemon/CLI processes and sockets                          |
| `apps/daemon/src/mcp.process.test.ts`                           | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/notification-race.process.test.ts`             | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/notifications.remote.process.test.ts`          | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/notifications.server.process.test.ts`          | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/ownership.server.process.test.ts`              | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/payloads.process.test.ts`                      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/pressure.process.test.ts`                      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/remote-boundaries.server.process.test.ts`      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/remote-cli.process.test.ts`                    | Daemon/CLI processes and sockets                          |
| `apps/daemon/src/remote-payloads.process.test.ts`               | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/remote.server.process.test.ts`                 | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/settings.remote.process.test.ts`               | TLS HTTP/WebSocket servers and settings authorization     |
| `apps/daemon/src/server.process.test.ts`                        | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/subscription.process.test.ts`                  | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/text-storage.process.test.ts`                  | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/daemon/src/ticket-allocation.server.process.test.ts`      | HTTP/WebSocket servers; remote fixtures also sign TLS     |
| `apps/relay/src/abuse.process.test.ts`                          | Real WebSocket relay and peers                            |
| `apps/relay/src/availability.process.test.ts`                   | Real WebSocket relay and peers                            |
| `apps/relay/src/relay.process.test.ts`                          | Real WebSocket relay and peers                            |
| `apps/relay/src/throttling.process.test.ts`                     | Real WebSocket relay and peers                            |
| `apps/relay/src/validation.process.test.ts`                     | Real WebSocket relay and peers                            |
| `packages/adapter-testkit/src/cli.process.test.ts`              | Bun workspace command and real Node CLI processes         |
| `packages/git/src/checkpoints.process.test.ts`                  | Real Git processes and temporary repositories             |
| `packages/git/src/diff-resources.process.test.ts`               | Real Git processes and temporary repositories             |
| `packages/git/src/diff.process.test.ts`                         | Real Git processes and temporary repositories             |
| `packages/git/src/lifecycle.process.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/git/src/malformed.process.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/git/src/nested.process.test.ts`                       | Real Git processes and temporary repositories             |
| `packages/git/src/numbering.process.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/git/src/process-runtime.process.test.ts`              | Real Git processes and temporary repositories             |
| `packages/git/src/repository.process.test.ts`                   | Real Git processes and temporary repositories             |
| `packages/git/src/review-regressions.process.test.ts`           | Real Git processes and temporary repositories             |
| `packages/git/src/worktrees.process.test.ts`                    | Real Git processes and temporary repositories             |
| `packages/mcp-server/src/admission.process.test.ts`             | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/discovery-apis.process.test.ts`        | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/discovery-fifo.process.test.ts`        | mkfifo process                                            |
| `packages/mcp-server/src/http-boundaries.process.test.ts`       | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/http.process.test.ts`                  | Real HTTP/MCP server and clients                          |
| `packages/mcp-server/src/lifetime.process.test.ts`              | Real HTTP/MCP server and clients                          |
| `packages/notify/src/apns.process.test.ts`                      | HTTP/2 server                                             |
| `packages/notify/src/ipc.process.test.ts`                       | Real Node notification worker                             |
| `packages/notify/src/webpush.process.test.ts`                   | HTTP server                                               |
| `packages/notify/src/worker.process.test.ts`                    | Real Node notification worker                             |
| `packages/orchestrator/src/git-boundary.process.test.ts`        | Real Git processes and temporary repositories             |
| `packages/orchestrator/src/git.process.test.ts`                 | Real Git processes and temporary repositories             |
| `packages/provider-kit/src/discovery/discovery.process.test.ts` | Real Node/shell processes; discovery also uses a TCP gate |
| `packages/provider-kit/src/jsonrpc.process.test.ts`             | Real Node/shell processes; discovery also uses a TCP gate |
| `packages/provider-kit/src/live.process.test.ts`                | Opt-in installed CLI handshakes and local server          |
| `packages/provider-kit/src/process.process.test.ts`             | Real Node/shell processes; discovery also uses a TCP gate |
| `packages/provider-kit/src/sse-recovery.process.test.ts`        | Real HTTP/SSE server                                      |
| `packages/provider-kit/src/sse.process.test.ts`                 | Real HTTP/SSE server                                      |
| `tools/recorder/src/stdio.process.test.ts`                      | Synthetic Node CLI processes; no subscription use         |

The additional suites from `19a7e14` are:

| Test file                                       | Real edge                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `apps/daemon/src/models.server.process.test.ts` | HTTP/WebSocket servers, private TLS files and model SQLite workers |
| `packages/models/src/catalog.process.test.ts`   | Model SQLite workers and restart persistence                       |
| `packages/models/src/discover.process.test.ts`  | Real Node CLI processes and model SQLite workers                   |
| `packages/models/src/review.process.test.ts`    | Real Node CLI processes and model SQLite workers                   |
| `packages/models/src/storage.process.test.ts`   | Model SQLite workers                                               |
| `packages/models/src/streaming.process.test.ts` | Real Node CLI processes                                            |

The live-provider suite remains opt-in through `ACE_LIVE_CLI=1`. Ordinary runs
skip it and use controlled stand-ins; the recorder itself is never invoked.
Other tests in the requested directories use pure logic, schema parsing,
filesystem/SQLite fixtures or injected process boundaries without starting a
real process or listening server. Future real-I/O suites should join the manifest.

PR #40 also registers `input-capacity`, `notification-shutdown`, `outbox-work`,
`presence-pressure` and `delivery-runtime` daemon tests in the process project.
They use real sockets and, for presence pressure, the real notification worker.
Their behavior and work-budget assertions need run at merge.

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

PR #7 adds the terminal PTY, shell, scrollback review, lifetime lease, frozen-daemon, memory and foreign-group safety suites to the shared process-test manifest. These keep output/process barriers and behavior assertions, with the shared 120-second hang guards. Runtime validation needs run at merge.

## Settings merge failure follow-up

After settings joined the daemon, bundling its jsonc-parser dependency produced
`Cannot find module './impl/format'` in the real CLI. The bundle now leaves all
package imports external instead of keeping an expanding package allowlist.
The settings remote suite also belongs to the process manifest so it receives
the shared TLS identity from global setup.

The owner authorized only these three files for this fix. The command below
reproduced the reported module error and missing TLS fixture before correction,
then passed all three files and all 11 tests afterward. Existing stdout, process
exit and socket barriers were retained; no assertions or timing budgets changed.

```sh
bunx vitest run apps/daemon/src/settings.remote.process.test.ts apps/daemon/src/lifecycle.process.test.ts apps/daemon/src/remote-cli.process.test.ts
```

No other tests, full suite, benchmark or mutation run was executed. The complete
merge gate still needs run at merge.

## Filename-based process discovery

Suites using owned child processes or local transport peers end in `.process.test.ts`.
Vitest selects these files by glob, applies the shared process hang guards and setup,
and excludes them from the unit project. New suites register by filename; there is
no shared inventory file to edit. This train preserves the prior inventory and also
classifies newly integrated client, engine and history transport/process suites.

## File transfer review additions

The inventory now includes daemon `files*.test.ts`, all `packages/files` suites and all `packages/workspace` suites. These own real WebSockets, Noise relay endpoints, native rename/blob workers, Git commands and search workers. The CLI bundle keeps `@ace/files` external so its worker URLs resolve beside its source. The new regression cases and this composed bundle need run at merge; no tests or runtime probes were executed under the owner's static-only policy.

## Backend hardening verification, 2026-10-03

The owner explicitly authorized targeted development test runs for this batch.
`process-runtime.process.test.ts`, `pi-discovery.process.test.ts`,
`numbering.process.test.ts` and settings `files.test.ts` each passed 20
consecutive runs with two parallel `yes` CPU hogs. All hogs were stopped afterward.
No timeout was increased and the full suite was not run.

The Win32 process fixture uses a TCP acknowledgement after descendant exit rather
than filesystem notifications. Pi discovery isolates Cursor SDK resolution and
injects the startup timer boundary. The checkpoint regression creates a real ref
lock and releases it on child close, reproducing the failure before the competing
writer publishes a new SHA. The settings regression drives the missing-directory
poll and debounce scheduler explicitly. Reconciliation no longer relies on
`watchFile` observing its first missing-file sample before directory creation.
