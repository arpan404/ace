# PR #91 review follow-up

The owner superseded the earlier targeted-test exception: tests, mutation runs,
flakiness runs, benchmarks, probes and CI execution are forbidden in this round.
All rows below are **not executed (tests run at merge)**. Regression reproduction
and green confirmation, including Windows native execution, **need run at merge**.
The earlier runs recorded in `process-tests.md` describe the original branch,
not the review follow-up changes.

| Public behavior guard                                                                                                               | Mutation cases the guard is designed to kill                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client `socket-admission.process.test.ts`: capacity reconnects with limit error, waits five seconds and recovers after a slot frees | Restore a pre-welcome error frame; use fatal 1009; make 4013 fatal/protocol; remove limit error; remove minimum delay; never clear the error after welcome                                      |
| Same file: transient service admission recovers with ordinary backoff                                                               | Restore a pre-welcome service error; map 1011 to fatal; omit retry; remove retry delay                                                                                                          |
| Daemon `socket-admission.server.process.test.ts`: loopback origins and remote paired-device admission                               | Remove the loopback origin check; reject a paired native remote client by its URL-derived Origin; omit allowed desktop/configured/native cases                                                  |
| Same file: full device subscriber budget still admits files channels and closes excess main channels with reason                    | Subscribe every admin channel; use 1006/1009; omit `connection_limit`; leak an admitted slot after disconnect                                                                                   |
| Client `device-transport.process.test.ts`: dedicated channel limit snapshot and delayed recovery                                    | Drop the close code; report only disconnected; fail permanently; retry immediately; retain the limit error after welcome                                                                        |
| Settings `files.test.ts`: missing parents stay idle and first creation reconciles                                                   | Call `changed` on every stat tick; reload/rewatch/read absent files repeatedly; omit existence transition; remove creation reconciliation                                                       |
| Browser `identity.process.test.ts`: identity failure, missing PID, cancellation and deadline release the profile                    | Await identity before owning teardown; omit fallback close; ignore cancellation; omit the identity deadline; accept a missing browser PID                                                       |
| Browser `cleanup.process.test.ts`: stalled real Chromium close releases the service                                                 | Reuse startup deadline; omit force kill; reject forced cleanup; signal a nonpositive PID                                                                                                        |
| Same file: asynchronous Windows kill tolerates an already-exited owned process                                                      | Replace the injected asynchronous command edge with a synchronous command; reject taskkill failure after process exit; ignore the command's pending completion                                  |
| Daemon `services/cleanup.test.ts`: cleanup has an independent eight-second deadline and accurate error                              | Use the startup deadline/message; restore 30 seconds, exceeding desktop's ten-second grace                                                                                                      |
| Git `numbering.process.test.ts`: transient locks recover and stale locks pace retries/preserve the diagnostic                       | Treat unchanged locked counter as fatal; remove retry delay; exceed retry budget; replace final lock stderr with “refs changed repeatedly”                                                      |
| Recorder `fragment-redaction.test.ts`: wrapped/interleaved paths, record bound, split secrets and credential introducers            | Test only `tail.startsWith('/')`; flush another stream mid-path without dropping its continuation; publish partial secret tokens at capacity; forget Bearer/Basic context; combine agents' text |
| Recorder `fragment-capture.process.test.ts`: passive public capture sink never writes split home/temp/workspace fragments           | Scrub each fragment independently; bypass fragment redaction in the sink; omit flushing on close                                                                                                |
| Dev `browser-deps.process.test.ts`: Node roots/built-ins/third parties fail; portable/browser/type-only/test imports pass           | Remove browser-no-node; stop at node_modules; follow erased type-only edges; omit browser export resolution; reject portable subpaths                                                           |

The review did not provide mutation-run results or a list of surviving executable
mutants; the table enumerates the faulty production variants described there.
No mutant is claimed killed by execution in this round.

## Performance evidence and merge-time bar

The review measured a subscribed workspace/thread settings scope over three idle
seconds: origin/main performed **2 reads**, and the original PR performed **10
reads**. These are historical reviewer measurements, not new benchmark results.
The revised poll stats only the known-missing ancestor and emits a change only
when that ancestor exists. Static inspection predicts **0 additional document
reads while missing ancestors remain absent**; matching the historical baseline
of 2 reads over the same interval **needs run at merge**. At the 64-file cache cap,
a 500 ms poll has a steady-state ceiling of **128 cheap existence stats/second**, rather than
repeated document parsing, watch lease replacement and ancestor-chain walks.

Fragment handling remains bounded to 32 records / 256 KiB, 10,000 visited nodes
per record, depth 32 and 64 continuation states. Each flush joins and scrubs each
stream once; work is linear in admitted text, with constant bounds on records and
streams. Forced flushes may omit unfinished prose to avoid losing secret context.
Oversized fragments fail closed. Throughput, peak-memory and current-tree idle
benchmark numbers **need run at merge**; no benchmark was executed here.

## Capture and integration limits

The raw `nested-task.jsonl` capture was unavailable locally. Its existing fixture
was neither hand-edited nor regenerated, and no provider CLI received a prompt.
The passive capture regression guards future recordings. An approved new capture
or a recovered raw original is required to replace the existing redacted fixture.

`origin/main` was already an ancestor when the requested fetch and merge ran.
Open PRs were checked with `gh pr list`; ADR 0063 remains the in-app devices ADR
and all remaining 0056 references describe web performance. No comment titled
“Integration rehearsal: findings for this PR” was present when comments were read.

## UI follow-up for the Claude web agent

No UI files were changed. The web devices adapter currently wraps every event as
`{ data }`, discarding `CloseEvent.code`. Preserve the original close event when
supplying `AuthenticatedChannelOptions.socket` to `@ace/client`'s `deviceTransport`
or `authenticatedChannel`. Code 4013 then sets `DeviceClientSnapshot.error.code`
to `limit` and retries with 5–30 second backoff. Render that retry state through
`DeviceClient.watch()` / `getSnapshot()`; the main connection exposes it through
`Client.error` and `Client.connectionState()`. React Native should use its paired
device ticket with the remote listener; URL-derived Origin headers are accepted.
