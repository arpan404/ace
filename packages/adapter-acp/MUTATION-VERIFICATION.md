# ACP mutation verification

The repository owner now requires tests to run only at merge. No tests, benchmarks, probes, mutation runs or flakiness runs are executed after that rule. Runtime claims below describe historical runs before the rule; final-head runtime verification **needs run at merge**. Existing behavior tests remain committed.

## Merge-time mutation plan

Each case below is designed to fail its named public behavior test. Revalidation status for every case is **not executed (tests run at merge)**. Earlier sections record the historical evidence separately.

| Case          | Behavior guarded                                                   | Status                            |
| ------------- | ------------------------------------------------------------------ | --------------------------------- |
| D1a           | Reparenting clears actual and pending canonical spawn ownership    | not executed (tests run at merge) |
| D1b           | Nullable spawn clearing survives JSON/schema and client replay     | not executed (tests run at merge) |
| D2a           | Null, array and numeric input cannot replace valid input/name      | not executed (tests run at merge) |
| D2b           | Malformed Antigravity names cannot replace valid names             | not executed (tests run at merge) |
| D2c           | Delayed original input remains visible after partial updates       | not executed (tests run at merge) |
| D2d           | Unknown initial metadata remains in live and terminal snapshots    | not executed (tests run at merge) |
| D3a           | Interpretation does not accumulate opaque input history            | not executed (tests run at merge) |
| D3b           | Ordinary refreshes do not serialize the collected input map        | not executed (tests run at merge) |
| D3c           | All collected fields survive completion                            | not executed (tests run at merge) |
| D3d           | Terminal raw assembly contains all fields, not just original input | not executed (tests run at merge) |
| D3e           | Completed MCP details retain all streamed arguments                | not executed (tests run at merge) |
| D3f           | Permission-placeholder arguments participate in final assembly     | not executed (tests run at merge) |
| F15           | Settled shell identity cannot overwrite an old item after restart  | not executed (tests run at merge) |
| N15           | Current snapshots retain original input alongside the latest frame | not executed (tests run at merge) |
| M5            | Child grace remains live until its injected deadline               | not executed (tests run at merge) |
| M13           | ACP v2 rejects before creating a native session                    | not executed (tests run at merge) |
| M14           | A process start clears stale lifecycle state                       | not executed (tests run at merge) |
| M21           | Malformed stdio text retains its complete raw payload              | not executed (tests run at merge) |
| Output stream | Antigravity completion retains summary and emitted output bytes    | not executed (tests run at merge) |

## Historical execution before the owner rule

Each behavior-changing mutation below modified production code, ran the complete offline adapter suite, failed at least one named public API behavior test, and was restored before the next run. No provider CLI received a prompt. The four review survivors are **M5, M13, M14 and M21**; all now fail tests. M5 changes only the child cancellation deadline to 1 ms, leaving the parent's wake deadline intact.

| Mutation | Broken behavior                                     | Detecting behavior test                                                                  |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| M1       | Nonzero exit succeeds                               | releases an uncertain shell only when a later terminal update confirms its completion    |
| M2       | Ignore output error                                 | infers failed tools from completed raw output {"error":"oops"}                           |
| M3       | Ignore Cursor text error                            | classifies only final Cursor error segments including split prefixes                     |
| M4       | Lose terminal child-tool linkage                    | recognizes background spawn completion before child registration and waits for the child |
| M5       | Child grace expires after 1 ms, root wake unchanged | exposes the child cancellation grace to the engine deadline scheduler                    |
| M6       | Rejected plan encoded accepted                      | queues reprompts until the current turn settles and forwards extension responses         |
| M7       | Targeted cancel goes to root                        | routes targeted cancellation by the translator's child key                               |
| M8       | Placeholder claims full fidelity                    | models Antigravity subagent calls as placeholder children and ends them with their tool  |
| M9       | Question becomes approval                           | turns Antigravity interaction permissions into single choice questions                   |
| M10      | Rejected plan runs                                  | keeps a rejected plan declined when Cursor later reports completion without output       |
| M11      | Drop unknown raw                                    | keeps unknown and malformed frames as raw without rejecting later traffic                |
| M12      | Ignore live-child queue gate                        | holds queued prompts while a child remains live and sends cascade cancellation           |
| M13      | Skip protocol validation                            | rejects ACP v2 before creating a native session                                          |
| M14      | Ignore process start                                | restarts work after an unexpected exit without retaining the old active turn             |
| M15      | Ignore process exit                                 | replays interrupt.jsonl with correct status checkpoints                                  |
| M16      | Enable old-version controls                         | enables Cursor controls only for a discovered version with recorded support              |
| M17      | Drop image data                                     | preserves native image and file input as canonical content                               |
| M18      | Accept invalid question                             | encodes Antigravity answers as permission option IDs                                     |
| M19      | Null draft state ends child                         | accepts draft child associations and only ends work for a concrete idle snapshot         |
| M20      | Resolve discarded queued jobs                       | rejects active and queued input when its owned process lifetime ends                     |
| M21      | Drop malformed raw only (stdio-text)                | keeps unknown and malformed frames as raw without rejecting later traffic                |
| R1       | Remove generation namespace                         | resume creates new items and runs while preserving earlier history                       |
| R2       | Retain deliberate-stop flag on restart              | does not carry deliberate stop across a reopened process                                 |
| R3       | Keep child interrupted on live text                 | reopens a synthetically interrupted child when late live text proves it is running       |
| R4       | Keep stale child parent                             | uses repaired native parentage for cascade cancellation                                  |
| R5a      | Accept extra question IDs                           | rejects extra Antigravity question IDs before any answer is transmitted                  |
| R6       | Ignore stdout EOF                                   | rejects active work and stops the process when stdout ends while it is alive             |
| R7       | Disable cancellation grace watchdog                 | rejects queued input at cancellation grace when a child never confirms termination       |
| R8       | Retain unbounded raw history                        | emits a bounded raw change for each tool refresh while retaining its initial input       |
| R9       | Drop explicit child disconnect                      | publishes unresponsive rather than working for a disconnected child                      |
| R10      | Discard original child envelope                     | retains complete child envelopes including unknown params and outer fields               |

The suite caught all 21 review mutations and 10 additional behavior-changing probes. An exploratory encoder mutation selecting the first answer was equivalent after extra question IDs were rejected: Antigravity permission requests contain exactly one valid question. It was excluded from the meaningful count; R5a separately removes the extra-ID rejection and fails the public session test. The production encoder still selects by the pending question ID.

The EOF probe closes the fake server's actual stdout descriptor while leaving stdin open. With the stdout-close handler removed, the public send behavior test times out; with the handler restored it rejects input and reports an unexpected process exit. Probe timeouts are hang watchdogs, not performance assertions.

The unmodified repository check covers formatting, lint, the 1,500-line source limit, types and Vitest. Live initialize probes stay opt-in and were skipped.

## Independent verifier follow-up

The verifier found that the original bounded-raw assertion could find original input in an earlier event even when later snapshots discarded it. Both that test and a new canonical-snapshot test now assert original input in every refresh. The exact **N15** mutation (`tool.raw = [payload]`) fails both tests and the delayed-input test.

All 13 probes below were applied individually to production code, ran the relevant public API behavior suites, failed the named behavior, and restored the exact original bytes in a `finally` block. The unmodified full check then passed. This round rechecked the four original survivors, N15, and eight new meaningful mutations.

| Probe | Broken behavior                                | Detecting behavior test                                                                  |
| ----- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| N15   | Discard original input on refresh              | emits a bounded raw change for each tool refresh while retaining its initial input       |
| V1    | Reuse a former parent tool                     | reparents a child linked to a former parent's tool without rejecting or moving that tool |
| V2    | Historical tool refresh undoes reparenting     | reparents a child linked to a former parent's tool without rejecting or moving that tool |
| V3    | Freeze placeholder input snapshot              | preserves delayed actual native input and name in the completed tool snapshot            |
| V4    | Allow a new uncertain-shell prompt             | rejects another prompt while a cancelled shell has no terminal execution evidence        |
| V5    | Release prequeued input after uncertain shell  | rejects input queued before a prompt reports uncertain shell completion                  |
| V6    | Forget uncertain native task identity on reset | reconciles an uncertain native shell after process restart without creating another tool |
| V7    | Lose actual background task precedence         | a live background shell takes precedence over a disconnected child                       |
| V8    | Do not settle former-parent background tasks   | finishes the original background task when its child completes under a repaired parent   |
| M5    | Expire child grace after 1 ms                  | exposes the child cancellation grace to the engine deadline scheduler                    |
| M13   | Skip protocol validation                       | rejects ACP v2 before creating a native session                                          |
| M14   | Ignore process start                           | restarts work after an unexpected exit without retaining the old active turn             |
| M21   | Discard malformed text                         | keeps unknown and malformed frames as raw without rejecting later traffic                |

The five verifier issues were also reproduced together before their fixes: linked-tool reassociation rejected canonical facts, delayed input disappeared, a second prompt escaped shell uncertainty, resumed terminal evidence left the original task unknown, and a disconnected child overrode a live background shell. Each failed a public API behavior assertion, then passed after its fix. A further reassociation probe reproduced an original-parent background task remaining running after child completion; it now passes too.

## Second independent verifier follow-up

D1, all three D2 variants, unknown initial snapshot metadata, and D3 byte growth failed public translator/core behavior assertions before their fixes. A separate reproduction also showed completed MCP arguments losing earlier input fields, including input introduced by a permission placeholder. Each now passes. The existing linked-tool test checks cleared canonical ownership and a JSON/schema round-trip of the nullable clear event, rather than only parent and tool ownership.

The new settled-ID behavior passes normally and fails under exact F15, removal of `s.settleShell(tool)`: the original completed tool is overwritten after a same-session process restart. The test also asserts original command/status preservation and distinct canonical IDs.

These 18 mutations were applied individually, failed the named public behavior tests and restored exact original bytes after each. Malformed cases have explicit null/array/number labels.

| Probe | Broken behavior                                              | Detecting behavior test                                                                           |
| ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| F15   | Reuse settled shell identity after same-session restart      | a settled shell ID creates a new tool after restarting the same native session                    |
| D1a   | Keep a conflicting canonical spawn link after reparent       | reparents a child linked to a former parent's tool without rejecting or moving that tool          |
| D1b   | Drop nullable spawn clearing at the wire boundary            | reparents a child linked to a former parent's tool without rejecting or moving that tool          |
| D2a   | Overwrite valid interpreted input with malformed values      | keeps valid input and native name after malformed input null                                      |
| D2b   | Replace valid Antigravity native name with malformed name    | a malformed native name null cannot replace the last valid Antigravity tool name                  |
| D2c   | Lose delayed original input during later partial refreshes   | preserves delayed actual native input and name in the completed tool snapshot                     |
| D2d   | Discard unknown initial tool metadata on later snapshots     | keeps unknown initial tool metadata in later live and completed snapshots                         |
| D3a   | Accumulate and republish opaque input through interpretation | partial input changes scale linearly while final snapshots preserve every input field             |
| D3b   | Serialize accumulated input during every partial refresh     | partial input changes scale linearly while final snapshots preserve every input field             |
| D3c   | Lose collected partial fields from terminal snapshots        | partial input changes scale linearly while final snapshots preserve every input field             |
| D3d   | Keep only original input in the completed raw snapshot       | partial input changes scale linearly while final snapshots preserve every input field             |
| D3e   | Lose collected native arguments from completed MCP details   | completed MCP details include all streamed top-level native arguments                             |
| D3f   | Ignore input decoded from a permission placeholder           | MCP permission placeholders retain their original arguments through streamed input and completion |
| N15   | Discard original input on refresh                            | emits a bounded raw change for each tool refresh while retaining its initial input                |
| M5    | Expire child grace after 1 ms                                | exposes the child cancellation grace to the engine deadline scheduler                             |
| M13   | Skip protocol validation                                     | rejects ACP v2 before creating a native session                                                   |
| M14   | Ignore process start                                         | restarts work after an unexpected exit without retaining the old active turn                      |
| M21   | Discard malformed stdio text                                 | keeps unknown and malformed frames as raw without rejecting later traffic                         |

This round rechecks F15, N15 and M5/M13/M14/M21. The partial-input byte test catches both accumulating opaque fields in interpretation and assembling them into raw on every change. Removing terminal collection or assembly also fails the preservation assertions, so the scaling assertion cannot pass by dropping input. Benchmark CPU/wall numbers are informational; the byte assertion is deterministic.

Two public core/client-replay tests cover clearing an actual spawning item and invalidating a pending old spawning item. Both fail when canonical unlinking is disabled and pass when restored. The subsequent main payload-contract merge exposed five type errors; narrowing locally produced raw data to the inline variant and guarding public union assertions resolves them without casts or runtime behavior changes.

## Third static verifier follow-up

No test, mutation or benchmark in this round was executed. Every case below is **not executed (tests run at merge)**. The tests assert public translator facts and canonical core results, including follow-up refreshes rather than stopping at the first completion.

| Mutation case                                                   | Behavior test designed to kill it                                                                  | Status                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| E1a Recompute completed MCP arguments from reduced input        | MCP completion keeps all arguments after output-only and duplicate terminal refreshes              | not executed (tests run at merge) |
| E1b Omit collected detail on synthetic end                      | synthetic cancelled/end_turn preserves the full MCP input and arguments                            | not executed (tests run at merge) |
| E1c Drop cached arguments on reopening                          | a reopened MCP tool keeps collected arguments through live metadata and renewed completion         | not executed (tests run at merge) |
| E1d Suppress meaningful late MCP identity refresh               | late MCP metadata changes publish typed tool identity without losing collected arguments           | not executed (tests run at merge) |
| E2 Omit terminal assembly on deny                               | permission denial assembles every streamed input field in the declined snapshot                    | not executed (tests run at merge) |
| E3a Replace live prefix with full terminal history              | late metadata event bytes are independent of completed input history size                          | not executed (tests run at merge) |
| E3b Republish full canonical input on passive terminal metadata | late metadata event bytes are independent of completed input history size                          | not executed (tests run at merge) |
| E3c Resend stored cumulative output on metadata                 | shell metadata refreshes do not republish cumulative output and later output emits only its suffix | not executed (tests run at merge) |
| E3d Append the full cumulative string rather than its suffix    | shell metadata refreshes do not republish cumulative output and later output emits only its suffix | not executed (tests run at merge) |
| E3e Rewrite terminal input on late Cursor extension             | late Cursor extension requests preserve assembled terminal input without resending it              | not executed (tests run at merge) |
| Output prefix Compare only the retained tail                    | a long shell prefix correction is retained as raw instead of silently accepted as an append        | not executed (tests run at merge) |
| Uncertainty Skip same-status native cancellation as passive     | native cancellation still settles a synthetically cancelled uncertain shell with the same status   | not executed (tests run at merge) |
| I15 Drop native background flag during output filtering         | a restored background tree stays working while its child has an active run                         | not executed (tests run at merge) |
| I15 Adapter queue clear releases unknown shell                  | restored shell uncertainty holds waiting after restart and after adapter queue clearing            | not executed (tests run at merge) |
| I15 Clear disconnected state on process start                   | restored child connection loss stays unresponsive until native child traffic reconnects it         | not executed (tests run at merge) |

The carried-forward M5/M13/M14/M21/N15/F15 and New1–New12 mappings in the verifier report remain applicable, with the same unexecuted merge-time status. New12 now maps to the existing public core test “accepts legacy draft output strings as append-only deltas without resending existing bytes” in `packages/core/src/legacy-output.test.ts`; suppressing core legacy suffix emission would break its first/second delta assertions. ACP now emits explicit suffix deltas and no longer exercises that compatibility path. No core test or production file was changed this round. Persistence file decoding and engine queue-source migration are not covered by trusted-state restoration tests.

Main merge `6f8e563` brings the queue-source contract from `77c3351`. The additional I15 mutation “classify ACP client queue as provider queue or discard engine queue on restart” is designed to fail “restored engine input survives provider restart while stale native queue is dropped”. Status: **not executed (tests run at merge)**. The merge preserves both main's queue-source validation and ACP disconnected/reconnected validation without new core behavior. Old persistence files missing queue sources still require the engine/core owner's versioned migration.
