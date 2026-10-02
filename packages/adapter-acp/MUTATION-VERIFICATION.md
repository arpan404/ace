# ACP mutation verification

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
