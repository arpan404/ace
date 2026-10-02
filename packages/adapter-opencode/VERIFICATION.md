# Verification

Offline verification on this branch uses Vitest, the public adapter contract, core facts and projected client views. Session tests start a boundary double for the installed CLI as a real child process with a real authenticated HTTP/SSE server. They synchronize on received frames and HTTP responses, without sleeps or elapsed-time assertions. No provider prompt or recorder was run.

The review follow-up merged `origin/main` before changes. The nine fixture expectation files remain unchanged. The package now has 78 passing tests and one skipped health-only live test. `bun run check` passed format, lint, the 1,500-line size limit, all workspace typechecks and 627 tests after the latest origin/main merge; five live tests were skipped. The first run after merging relay/notification work hit default five-second timeouts in fixture replay and daemon lifecycle; the unchanged full-check rerun passed all 627 tests. Session regressions use the exported adapter factory, real authenticated HTTP/SSE and child processes; the shutdown deadline is driven through an injected scheduler.

## Fixture timelines

All nine expectation files pass through `@ace/adapter-testkit`'s `replayFixture` and `assertExpectations`, using transport liveness at 25 seconds. The testkit timeline CLI was also run for every fixture with its expectation checkpoint times.

| Fixture             | Checkpoints and final state                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| tool-read           | Working at 1244 and 5568; done at 7231; one agent.                                                                                              |
| approval-edit       | Needs input at 8063, working at 8070, done at 9359; one resolved approval.                                                                      |
| question            | Needs input at 5773, working at 5780, done at 7279; one resolved question.                                                                      |
| plan-review         | Clarifying questions at 71873 and plan review at 113465; done at 113588; two agents and seven resolved interactions.                            |
| subagent            | Child announced at 14528; approvals at 18103 and 23236; root still working at child completion 26694; done at 28789.                            |
| subagent-background | Root blocked while child works at 9703; result delivery at 15621 leaves root working and child idle; done at 18399.                             |
| background-shell    | Healthy reasoning at 100000; approvals at 170232 and 173123; done at 187558; no provider-visible detached shell task.                           |
| interrupt           | Working at 16649, waiting for surviving shell at 16661, done after terminal tool update at 16669; second idle at 16725 leaves root interrupted. |
| retry-overloaded    | Upstream waits at 3378, 73739 and 104673; heartbeats maintain healthy working between retries; final remains waiting.                           |

Core's settled-root/working-child precedence makes the background-subagent thread working while its root is blocked. Pending input is represented by `wake.expected`, whose canonical status is working with starting-turn activity. Those choices keep the tree live and follow the existing core API.

## Behavior coverage

- Late child announcements bind to their later spawn item without creating another agent.
- Busy-before-user child ordering still starts one run and reports reasoning activity.
- Duplicate abort idles cannot settle a surviving shell or create a second run.
- Injected task results complete the background job and label the resumed run `subagent_result`.
- The three-second fallback keeps a job live before its deadline and settles it afterward.
- Rate limits, network failures and overload retries remain blocked until native recovery.
- Native retry timestamps are converted into the injected replay clock.
- Transport heartbeats cover quiet retries; their disappearance becomes unresponsive.
- Reasoning's native text deltas reach reasoning items without modifying input data.
- Rejected questions preserve dismissal and decline the backing tool without failing the turn.
- `plan_exit` opens plan review; observed successful plan writes supply its contents.
- Native authentication errors fail the turn; ordinary assistant error text remains transcript text.
- A failed prompt delivery clears its pending-input wake and reports failure.
- A complete turn missed during disconnection can be recovered as settled.
- Transport loss expires interactions and REST resync can reopen them.
- Unknown payloads stay raw and durable sync twins do not duplicate items.
- Tool-kind mappings render typed details while retaining native names and inputs, including MCP server names with underscores.
- One authenticated process serves multiple directories and forwards file/image/model inputs.
- Queueing waits for children and for the background-result parent's resumed turn.
- Approval replies, ordered question answers, dismissal and plan decisions use their native HTTP routes.
- Cascade interruption aborts descendants; stopping a task addresses its native session.
- Reconnect restores missed child messages, statuses and interactions from REST.
- Deltas received while a snapshot is read do not get appended twice.
- Closing rejects queued input, protects active sessions from idle-close and allows later process restart.
- Relative file attachments resolve inside the session directory.
- Injected time/counters keep outgoing message IDs in native history order.
- Ambiguous model names are rejected before HTTP input is built.
- Unsupported or unrecognized CLI versions are rejected before sessions start.

## Review regressions

Each blocking finding was reproduced before its production fix. The first translator run failed on early authentication errors, resumed busy/retry grace, historical retry clocks, missing recognized metadata, and unbounded completed-part reconciliation. The first session run failed on foreign buffered disclosure, foreign traffic starving recovery, surviving-shell queue bypass, and local cancellation waiting for stalled abort. The failing assertions observed facts or projected views, raw frame delivery, accepted HTTP commands, and queued-promise settlement.

- Early authentication failure before busy ends one failed run and clears pending wake, including a missing user announcement when the sent native message ID is known.
- Child busy and retry both invalidate an earlier idle grace deadline.
- Receipt wall/monotonic clocks keep a retry five seconds away after restoring year-old history.
- Recognized session metadata retains future native fields as raw evidence.
- Completed-part eviction preserves live parts and recent delta routing; older deltas stay raw.
- Step-finish input, output, cached tokens and cost reach projected usage.
- Later deltas preserve the input frame and previously returned raw evidence.
- Reusing a provider buffer cannot rewrite nested tool input in emitted facts.
- Foreign buffered recovery data never reaches another thread context, including project-tagged events whose directory is global.
- Foreign and owned continuous traffic cannot extend recovery past two snapshot passes.
- A surviving shell after abort holds queued delivery until its terminal tool update; stop addresses the child owner.
- A provider roundtrip proves a busy child still holds delivery after the root idles.
- Stalled abort cannot delay local queued-work cancellation; an injected deadline completes release.
- A streamed UTF-8 history value arrives before the response completes.
- Paged history imports all transcript parts, then a second recovery keeps the latest completed turn settled.
- GET history requests never create pending-input wake.
- Snapshot receipt watermarks prevent stale buffered idle from replacing newer busy REST status.
- Injected receipt clocks also work through the live I/O shell.
- Heartbeat-gap recovery reconnects SSE before reporting transport restored.
- An early grace callback rearms instead of stranding queued delivery.
- Injected task results settle the background job even before their user-message announcement.
- Unknown native tool states remain pending and hold settlement until a terminal update.

## Performance

Measured offline on darwin arm64, Node v26.8.1. Benchmarks are reproducible scripts in `benchmarks/`; they contain no gating latency or memory assertions. Emitted facts are discarded for translator retention measurements, and GC runs before heap samples. Reported translator numbers are medians of three runs after a warmup. Each message has a unique 2,000-character completed text part. The delta sample translates 50,000 one-character reasoning deltas and checks delivery settlement on every iteration.

| Completed messages | Ingest    | Retained translator heap | Delta + settlement |
| ------------------ | --------- | ------------------------ | ------------------ |
| 20,000             | 223.48 ms | 0.22 MiB                 | 2.90 µs/frame      |
| 40,000             | 404.97 ms | 0.19 MiB                 | 2.43 µs/frame      |

The review measured 50.52/100.97 MiB at those sizes before this fix. The new caches retain compact metadata only, bounded by live work and fixed reconciliation windows. Delta processing never concatenates cached history; settlement uses indexes updated for the changed session and tool.

The recovery benchmark drives the public adapter against the boundary CLI double. Times include provider-kit's 500 ms reconnect backoff. Initial import is necessarily linear in history; subsequent reconnect uses one recent page in both cases.

| History | Initial recovery | Messages/pages | Later reconnect | Messages/pages |
| ------- | ---------------- | -------------- | --------------- | -------------- |
| 20,000  | 1603.77 ms       | 20,000 / 157   | 522.03 ms       | 128 / 1        |
| 40,000  | 3056.57 ms       | 40,000 / 313   | 525.16 ms       | 128 / 1        |

## Mutation checks

All 22 review production mutations failed named behavior tests in the whole adapter suite and were reverted before the next mutation. The four review survivors are caught: 10 by the busy-child roundtrip barrier, 16 by projected usage, 18 by canonical spawn linkage, and 22 by provider-buffer reuse. The former full-part cache clone path was removed: caches now retain compact descriptors and never mutate content. The corresponding immutable-evidence fault is exercised by removing the raw boundary clone. Spawn linking now has one authority, `agent.linked.spawnedBy`, so corrupting that key can no longer be hidden by a redundant detail hint.

| Review # | Production fault                     | Failing behavior                                                                   |
| -------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| 1        | rate_limit becomes upstream          | holds a rate_limit retry until a busy signal                                       |
| 2        | network becomes upstream             | holds a network retry until a busy signal                                          |
| 3        | aborted tools succeed                | keeps an interrupted shell live through duplicate idles until terminal output      |
| 4        | plan_exit becomes ordinary question  | turns plan_exit into a review and treats rejection as a completed turn             |
| 5        | dismissed flag is removed            | resolves rejected questions as dismissed and declines the backing tool             |
| 6        | task becomes custom                  | renders task with typed details and retains its native input                       |
| 7        | reasoning deltas use text            | routes reasoning text deltas to reasoning and preserves the input frame            |
| 8        | grace expires immediately            | releases a background job after the result-delivery grace period                   |
| 9        | survivor detection removed           | interrupt.jsonl preserves its status timeline and final tree                       |
| 10       | busy children ignored by delivery    | does not send a queued prompt past a busy child after a provider roundtrip         |
| 11       | directory lost                       | shares one authenticated server and addresses each project directory               |
| 12       | buffered deltas reapplied            | does not append a buffered delta that the REST snapshot already contains           |
| 13       | HTTP authorization corrupted         | authenticated server rejects corrupted authorization before session creation       |
| 14       | cascade omitted                      | aborts known descendants and stops a background child independently                |
| 15       | dismiss via reply                    | routes ordered answers, dismissals, plan decisions and approval replies            |
| 16       | usage input always zero              | reports native usage and leaves returned raw evidence unchanged after later deltas |
| 17       | native tool raw removed              | holds queued input through background-result delivery and the resumed parent turn  |
| 18       | spawnedBy corrupted                  | links an announced child to its later task without creating a second agent         |
| 19       | supported version rejected           | supported 1.18.33 is accepted during session opening                               |
| 20       | attachments ignore cwd               | resolves relative file attachments in the session workspace                        |
| 21       | close resolves queued work           | cancels local queued work even when the abort endpoint never replies               |
| 22       | raw evidence defensive clone removed | keeps raw nested tool input independent of later provider buffer reuse             |

Four additional production faults also failed their public behavior tests and were reverted:

| #   | Production fault                              | Failing behavior                                                            |
| --- | --------------------------------------------- | --------------------------------------------------------------------------- |
| 23  | ignore snapshot receipt watermark             | older buffered idle cannot overwrite a newer busy REST snapshot             |
| 24  | do not rearm an early grace callback          | queued delivery remains held before, and proceeds at, the injected deadline |
| 25  | recover without reconnecting a stalled stream | opens a new SSE connection before restoring heartbeat-gap recovery          |
| 26  | ignore unfamiliar native live tool states     | holds the tool pending until a terminal update                              |

After the watermark and pure resolution refactors, the buffered-delta and question-dismissal mutations were rerun and still failed.

## Boundaries

The optional real-CLI test was not enabled in this run. It starts only the server and reads health after SSE connection, with no session creation or model input. The fixture recordings remain untouched.

The adapter drives v1 routes. `session.next.*` remains raw until a separate v2 translation contract is specified. Detached shells have no native task lifecycle, so capabilities report partial background visibility. Recovery uses at most two snapshot passes and cannot wait indefinitely for global traffic to stop. Buffered deltas are never appended to snapshot content; continuously streaming content converges at the provider's later full part updates. Provider I/O stays outside the translator.

A core-owner request remains for immediate transport liveness override: add `transport.lost` / `transport.restored` facts so recoverable SSE loss reports `unresponsive` immediately and throughout resync. The current contract supports silence-based detection only. This adapter emits loss/restoration lifecycle evidence, expires stale interactions and blocks queued input during recovery. It does not fake clocks or misreport recoverable outages as process exits. GitHub Actions [did not start either matrix job](https://github.com/arpan404/ace/actions/runs/37027346231) on the pushed branch because recent account payments failed or the spending limit needs to increase. Retrying the failed jobs produced the same pre-run failure. Local full checks passed; green CI requires an account billing change outside this worktree.

See [the request on PR #17](https://github.com/arpan404/ace/pull/17#issuecomment-5954715415).
