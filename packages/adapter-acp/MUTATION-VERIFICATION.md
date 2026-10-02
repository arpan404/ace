# ACP mutation verification

Each mutation changed production code, ran the adapter suite, failed a behavioral test, and was restored before the next mutation. The unmodified suite passed before and after the run. No provider CLI received input.

| Mutation | Broken behavior                                                  | Test that failed                                                                         |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| M1       | Treat a nonzero shell exit as success                            | infers failed tools from completed raw output {"exitCode":2}                             |
| M2       | Ignore error payloads on completed tools                         | infers failed tools from completed raw output {"error":"oops"}                           |
| M3       | Stop recognizing split Cursor error text                         | classifies only final Cursor error segments including split prefixes                     |
| M4       | Lose spawn linkage on terminal updates without repeated metadata | recognizes background spawn completion before child registration and waits for the child |
| M5       | Schedule child cancellation grace at the wrong deadline          | exposes the child cancellation grace to the engine deadline scheduler                    |
| M6       | Accept a rejected plan in the wire response                      | queues reprompts until the current turn settles and forwards extension responses         |
| M7       | Send targeted child cancellation to the root                     | routes targeted cancellation by the translator's child key                               |
| M8       | Claim a full Antigravity child transcript                        | models Antigravity subagent calls as placeholder children and ends them with their tool  |
| M9       | Turn Antigravity questions into approvals                        | turns Antigravity interaction permissions into single choice questions                   |
| M10      | Discard the plan rejection before Cursor completion              | keeps a rejected plan declined when Cursor later reports completion without output       |

M10 survived the first run because the plan test asserted decline only after a later completion update. The test now also checks the published tool status immediately after the rejection response. M10 failed on the repeat run. All ten mutations failed behavioral tests in the final run.

The full repository check covers formatting, lint, file size, types and Vitest. Live initialize probes stay opt-in and were skipped.
