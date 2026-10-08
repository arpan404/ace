# Historical v1 verification archive

This is the prior implementation's verification record. Its results apply to the named historical heads and CLI 1.18.33, not this v2 migration. Dynamic validation of the migration is deferred to merge.

# Verification

The repository owner requires static checks during authoring, with an explicit exception for specific test files covering merge conflicts. The latest merge used that exception as recorded below. Full-suite validation, probes, benchmarks and mutation runs still **need run at merge**. CI remains disabled. `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size` passed after integrating main through `4c2d6fb`. All 676 source files fit within 1,500 lines.

Behavior tests use the public adapter contract, core facts and projected client views. Session tests start a CLI double as a real child process with authenticated HTTP/SSE and synchronize through received frames and HTTP responses. Clocks and shutdown deadlines are injected. No installed provider received a prompt and no recorder ran.

This follow-up merged main and the ACP branch that supplies the shared transport facts, then merged main through `50c725f`, including the model catalog, automations, process-test reliability work. The nine fixture expectation files remain unchanged. Earlier reviews recorded passing suites and mutation campaigns before the new owner instruction; those results do not validate the final integrated head.

## Approved-main merge

Main at `46eb036` adds Claude's shared queue-source contracts and deadline scheduling, workspace, forge and diagnostics packages. Both merge conflicts are resolved: core fact validation accepts disconnected/reconnected facts and uncertain unknown tasks while retaining main's nonnegative safe-integer queue count and engine/provider source validation. The lockfile starts from main's version and was regenerated with `bun install --ignore-scripts`, retaining ACP and OpenCode workspace dependencies alongside main's dependencies.

OpenCode now consumes the shared `SessionContext.rootKey` and `Translator.nextDeadline()` APIs. Targeted root interrupts use engine identity even when it matches a native child key; stopping that child still addresses its native session. The previous grace-deadline method remains an alias.

The owner's merge-conflict exception authorized this exact test selection:

```sh
bunx vitest run packages/core/src/adapter-contracts.test.ts packages/core/src/acp-lifecycle.test.ts packages/adapter-opencode/src/verifier-translator.test.ts packages/adapter-opencode/src/background-index.test.ts packages/adapter-opencode/src/fixture.test.ts packages/adapter-opencode/src/session.test.ts
```

Result: **6 files, 40 tests passed**, both after the conflict resolution and again after merging main's subsequent core audit commit `4c2d6fb`. The final run completed in 6.70 seconds. This covers queue sources and rejected invalid sources, connection uncertainty, uncertain tasks, all nine fixture expectations, background status precedence, grace deadlines and HTTP session behavior. New assertions cover the shared deadline hook, a root/child key collision and independent child stopping. No full suite, CI, probes, benchmarks or mutations were run. Other dynamic validation **needs run at merge**.

Additional mutation cases designed for these public tests, all **not executed (tests run at merge)**:

- Drop disconnect/reconnect cases while retaining queue validation: the approval-loss and child-recovery tests must fail.
- Remove queue-source validation or ignore provider counts: the shared adapter-contract tests must fail.
- Ignore the engine root key when choosing the abort target: the root/child collision test must fail.
- Route native task stopping through engine root identity: the independent child-stop assertion must fail.
- Return a stale or missing shared translator deadline: the staggered background deadline assertions must fail.

## Fixture timelines

All nine fixture tests use `@ace/adapter-testkit`'s `replayFixture` and `assertExpectations`, with transport liveness at 25 seconds. The table records their intended checkpoints. The timeline CLI was used before the owner instruction; replay of the final integrated head needs run at merge.

| Fixture             | Checkpoints and final state                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| tool-read           | Working at 1244 and 5568; done at 7231; one agent.                                                                                              |
| approval-edit       | Needs input at 8063, working at 8070, done at 9359; one resolved approval.                                                                      |
| question            | Needs input at 5773, working at 5780, done at 7279; one resolved question.                                                                      |
| plan-review         | Clarifying questions at 71873 and plan review at 113465; done at 113588; two agents and seven resolved interactions.                            |
| subagent            | Child announced at 14528; approvals at 18103 and 23236; root still working at child completion 26694; done at 28789.                            |
| subagent-background | Thread working, root blocked and child working at 9703; result delivery at 15621 leaves root working and child idle; done at 18399.             |
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

Before the owner instruction, each original blocking finding was reproduced before its production fix. The first translator run failed on early authentication errors, resumed busy/retry grace, historical retry clocks, missing recognized metadata, and unbounded completed-part reconciliation. The first session run failed on foreign buffered disclosure, foreign traffic starving recovery, surviving-shell queue bypass, and local cancellation waiting for stalled abort. The failing assertions observed facts or projected views, raw frame delivery, accepted HTTP commands, and queued-promise settlement.

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

## Independent verifier follow-up

The following public regressions were written around the verifier's failing scenarios. Their execution on the final integrated head **needs run at merge**.

- B9: tool, text and reasoning parts retain `properties.unknownFuture="FUTURE_SIBLING_17"` in raw evidence. Native part data keeps its original shape; a separate envelope entry preserves sibling fields without duplicating the part body.
- Malformed recognized parts without IDs retain the full original frame, including unknown fields.
- N1: approval loss expires the interaction and reports unresponsive through heartbeat and busy frames. Shared `agent.disconnected` facts cover every known agent; children discovered during recovery receive the same fact. Only successful resync emits `agent.reconnected`.
- Recovery race: an injected fetch holds the second idle status response after reading its body. Newer busy SSE is processed through the real stream before release. Assertions require working status and one accepted prompt until a later live idle releases the second prompt.
- Idle eviction: idling one child evicts only that child's completed reasoning route. Another child's live reasoning still accepts deltas after the recent window fills.
- I15 integration note: after its parent turn ends, an active background child keeps the thread working. Once the child idles, the undelivered background result keeps it waiting. The existing fixture also expects working at t=9703; the shared core precedence is unchanged.

Snapshot receipt does not establish server generation order. Recovery observes owned updates synchronously and covers events only through snapshot request start, in both directions. It retains both passes' buffered events and replays only the latest update per entity before applying deferred idle snapshots. Running tools are registered before their owner settles; newer idle and completed-tool events supersede older busy/running responses. Replaying an intermediate idle before a later busy could close the native run permanently, so intermediate status evidence stays raw rather than settling the run.

### Second static verifier follow-up

- F1: the held idle-response test delivers a running tool without another busy event. Reconciliation registers it before idle and synthesizes a survivor task; the test requires waiting and one prompt until terminal shell evidence releases the queue.
- F2: held busy-status and running-history responses receive newer idle and tool completion over acknowledged SSE. The tests require done and immediate second-prompt delivery after resync, without another disconnect.
- Ordering regression: buffered idle followed by busy keeps the original active turn and the queue held.
- Timing risk: every history response waits for acknowledgment of its forcing SSE event, and tests await the initial busy frame before starting recovery. No sleep or scheduling budget is used.
- Performance note: child/item ownership indexes replace global background scans. A min-heap contains one entry per live grace deadline, without stale tombstones. Status updates touch only one child's jobs, survivor deduplication uses the item index, and ticks process due jobs only. Public tests cover staggered expiration, resume/re-idle, final settlement, duplicate survivor avoidance and late live tools.
- F3/I15 precedence: the combined background/approval disconnect test requires expired approval, unresponsive agents, a still-running background task, and the owner's waiting thread precedence. Resync restores working. This deliberately preserves the owner's contract; it does not implement the verifier's conflicting request to put thread unresponsive above waiting.

All these outcomes **need run at merge**; only static checks were run.

Before the owner instruction, an untouched main checkout at `709f66d` failed the local full check with 14 framework timeout errors under machine load above 250. The same main Git cases reproduced timeouts, and the previous adapter head merged with that main reproduced the background-shell fixture timeout. The integrated branch run also had framework timeouts. No unrelated test deadline was changed. Both temporary verification worktrees were clean and have been removed. No reruns are authorized now; the final suite needs run at merge.

## Performance

Historical measurements below were collected before the owner instruction on darwin arm64, Node v26.8.1. Final-head benchmark confirmation **needs run at merge**; no benchmark was rerun after the instruction. Benchmarks are reproducible scripts in `benchmarks/`; they contain no gating latency or memory assertions. Emitted facts are discarded for translator retention measurements, and GC runs before heap samples. Reported translator numbers are medians of three runs after a warmup. Each message has a unique 2,000-character completed text part. The delta sample translates 50,000 one-character reasoning deltas and checks delivery settlement on every iteration.

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

### Many live children

`node --expose-gc packages/adapter-opencode/benchmarks/live-tree.ts` measures 1,000/10,000 simultaneously live children. Each status cycle receives busy, one reasoning part and idle, then checks settlement; deltas target a different still-live child. Three runs supply medians after warmup. Machine load was 200 to 320, so process CPU time excludes scheduler waiting and wall times are diagnostic only.

| Scenario    | Live children | CPU / status cycle | CPU / delta + settlement |
| ----------- | ------------- | ------------------ | ------------------------ |
| Parts       | 1,000         | 24.75 µs           | 4.76 µs                  |
| Parts       | 10,000        | 26.85 µs           | 4.80 µs                  |
| Backgrounds | 1,000         | 71.96 µs           | 4.84 µs                  |
| Backgrounds | 10,000        | 404.44 µs          | 4.27 µs                  |

These live-tree measurements precede the latest background indexing fix. The former global part/background scans and per-tool background searches are now replaced by ownership indexes and an indexed deadline heap. Updating k jobs for one child costs O(k log L), expiring d jobs costs O(d log L), and minimum deadline and item ownership lookup are constant time, where L is the number of active grace deadlines. Storage has one heap entry per deadline. Final-head performance confirmation **needs run at merge**; no benchmark was rerun.

## Mutation plan

Every case in the following tables is **not executed (tests run at merge)** for the final integrated head. The named public tests are designed to kill these faults. Historical campaigns before the owner instruction caught the original survivors 10, 16, 18 and 22; no throwaway mutation remains applied.

The former full-part cache clone path is gone because caches now retain compact descriptors. Case 22 targets the raw boundary clone instead. Spawn linking has one authority, `agent.linked.spawnedBy`, so a redundant detail hint cannot hide case 18.

| Review # | Production fault                     | Guarding behavior                                                                  |
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
| 17       | native tool raw removed              | renders bash with typed details and retains its native input                       |
| 18       | spawnedBy corrupted                  | links an announced child to its later task without creating a second agent         |
| 19       | supported version rejected           | supported 1.18.33 is accepted during session opening                               |
| 20       | attachments ignore cwd               | resolves relative file attachments in the session workspace                        |
| 21       | close resolves queued work           | cancels local queued work even when the abort endpoint never replies               |
| 22       | raw evidence defensive clone removed | keeps raw nested tool input independent of later provider buffer reuse             |

Additional planned cases, each **not executed (tests run at merge)**:

| #   | Production fault                              | Guarding behavior                                                           |
| --- | --------------------------------------------- | --------------------------------------------------------------------------- |
| 23  | ignore snapshot request-start coverage        | older buffered idle cannot overwrite a newer busy REST snapshot             |
| 24  | do not rearm an early grace callback          | queued delivery remains held before, and proceeds at, the injected deadline |
| 25  | recover without reconnecting a stalled stream | opens a new SSE connection before restoring heartbeat-gap recovery          |
| 26  | ignore unfamiliar native live tool states     | holds the tool pending until a terminal update                              |

Verifier follow-up cases, each **not executed (tests run at merge)**:

| #   | Production fault                                  | Guarding behavior                                            |
| --- | ------------------------------------------------- | ------------------------------------------------------------ |
| 27  | omit shared disconnect facts                      | approval loss stays unresponsive through heartbeats          |
| 28  | omit disconnect for recovered children            | a newly discovered child stays unresponsive until resync     |
| 29  | discard native part envelope evidence             | tool/text/reasoning sibling fields stay raw                  |
| 30  | allow stale terminal snapshots despite newer work | the delayed idle response cannot release queued input        |
| 31  | apply idle snapshots before final reconciliation  | a newer running shell is registered before the idle snapshot |
| 32  | take status request start at receipt              | an in-flight busy event keeps the queue held                 |
| 33  | omit live-part owner index entries                | idling one child evicts its route without evicting another's |
| 34  | omit shared reconnect facts                       | successful resync restores working status                    |
| 35  | discard malformed part body                       | a recognized part without ID retains unknown fields          |

Second static follow-up cases, every row **not executed (tests run at merge)**:

| #   | Production fault                                      | Guarding behavior                                               |
| --- | ----------------------------------------------------- | --------------------------------------------------------------- |
| 36  | restore receipt-time terminal coverage                | newer idle settles an older busy response                       |
| 37  | finalize idle before replaying running tools          | newer shell stays live and holds delivery through old idle      |
| 38  | discard newer terminal status during reconciliation   | newer idle releases second input without another disconnect     |
| 39  | discard newer terminal tool as covered by old history | completed shell supersedes running history and releases input   |
| 40  | replay an intermediate idle before its newer busy     | original active turn survives buffered idle then busy           |
| 41  | retain background registry entries after completion   | staggered jobs finish and public settlement becomes true        |
| 42  | omit background item ownership entries                | an existing background tool cannot create a second survivor     |
| 43  | omit late live-tool survivor synthesis                | running shell after owner idle keeps the thread waiting         |
| 44  | skip disconnect facts when backgrounds exist          | affected background agents stay unresponsive through heartbeats |
| 45  | keep pending approval during disconnect               | approval expires during combined background/disconnect sequence |
| 46  | clear observations before deferred idle decisions     | newer busy holds the active turn and second prompt              |

## Boundaries

The optional real-CLI test was not enabled in this run. It starts only the server and reads health after SSE connection, with no session creation or model input. The fixture recordings remain untouched.

The adapter drives v1 routes. `session.next.*` remains raw until a separate v2 translation contract is specified. Detached shells have no native task lifecycle, so capabilities report partial background visibility. Recovery uses at most two snapshot passes and cannot wait indefinitely for global traffic to stop. Buffered deltas are never appended to snapshot content; continuously streaming content converges at the provider's later full part updates. Provider I/O stays outside the translator.

The second verifier follow-up merged `origin/feat/adapter-acp` to reuse core's `agent.disconnected` / `agent.reconnected` facts from PR #14. The original core-owner request is resolved. Known and newly recovered children remain unresponsive until resync; heartbeat/busy evidence cannot clear explicit loss. The owner's thread precedence remains authoritative, including waiting before unresponsive. No core/protocol implementation was written in this adapter branch.

That dependency predates main's large-payload unions. Its inline raw reads now narrow the `data` variant, and its assertions accept streamed shell-output tails. These three ACP compatibility files were the only direct edits outside OpenCode before the latest explicitly authorized core validation conflict resolution.

CI is disabled by the repository owner. This follow-up does not run, retry or watch CI. Static checks gate authoring; the approved-main merge above records the specific merge-conflict tests permitted by the owner. Other tests, mutations and benchmark confirmation need run at merge.

## Shared owner requests from I15 and F3

OpenCode's working checkpoint at t=9703 and the active-background-child regression remain unchanged. The combined loss test records the intended waiting thread plus unresponsive agent diagnostics. F3's requested global precedence reversal conflicts with the owner's explicit integration rule, so no adapter-specific override or shared-core edit was made. The core owner should reconcile fixture-analysis wording with that settled contract before calling this discrepancy fixed.

I15's snapshot migration belongs to [engine PR #15](https://github.com/arpan404/ace/pull/15) and [core/Codex PR #16](https://github.com/arpan404/ace/pull/16), which are not merged into this branch. Static inspection of `origin/feat/m3-engine` at `f4cd349` shows the engine snapshot decoder still validates a handwritten schema through `z.custom<ThreadState>` without a versioned migration for missing `queueSources`. The requested fix is a shared versioned state schema/default migration consumed by engine decode and record schemas, with restart coverage for provider/engine queue sources, disconnect metadata, explicit wait targets and uncertain tasks. Core's current public API exports no state decoder; an adapter-local decoder would duplicate owned persistence logic. Per the package ownership brief, this remains a concrete upstream request rather than an unauthorized change in core or daemon. Cross-PR persistence validation **needs run at merge** after those owners integrate the migration.
