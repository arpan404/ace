# Mutation cases

Current revision: **not executed (tests run at merge)**. Each case names a production change and the public behavior test designed to kill it. No production mutation is left applied.

| Mutation                                        | Guarding behavior                                                                       | Status                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| Remove insertion offsets                        | Follows an insertion above a comment                                                    | not executed (tests run at merge) |
| Keep deleted findings active                    | Keeps the last position when selected lines disappear                                   | not executed (tests run at merge) |
| Disable fuzzy fallback                          | Matches small edits using surviving context and asks for review                         | not executed (tests run at merge) |
| Choose the first ambiguous destination          | Does not guess between identical destinations                                           | not executed (tests run at merge) |
| Keep changed findings active                    | Matches small edits using surviving context and asks for review                         | not executed (tests run at merge) |
| Corrupt suggestion replacement text             | Applies a suggestion through git                                                        | not executed (tests run at merge) |
| Invert the requested resolution                 | Comments, replies and resolution survive reopening                                      | not executed (tests run at merge) |
| Bypass reviewer validation                      | Reviewer output rejects malformed comments                                              | not executed (tests run at merge) |
| Emit oversized excerpts                         | Fix payloads cap excerpts and aggregate size                                            | not executed (tests run at merge) |
| Replace disk SQLite with memory                 | Comments, replies and resolution survive reopening                                      | not executed (tests run at merge) |
| Forget terminal daemon receipts                 | Review ids deduplicate ordinary commands                                                | not executed (tests run at merge) |
| Replay unknown receipt recovery                 | Receipt recovery never starts an unknown effect                                         | not executed (tests run at merge) |
| Serialize reads behind an awaiting reviewer     | Reviews remain readable while a reviewer is waiting                                     | not executed (tests run at merge) |
| Remove admission backpressure                   | Excess work gets backpressure                                                           | not executed (tests run at merge) |
| Retain old text inside a changed long selection | A small insertion refreshes text outside the transition hunk; deletion removes old text | not executed (tests run at merge) |
| Treat a zero-count hunk coordinate as a line    | Zero-context insertions/deletions map after the caret                                   | not executed (tests run at merge) |
| Match deleted content to unchanged duplicates   | Deleted text cannot attach to identical unchanged context                               | not executed (tests run at merge) |
| Advance the revision of an unplaced finding     | Unrelated changes preserve an outdated finding's last revision and position             | not executed (tests run at merge) |

Historical evidence: the first twelve mutations were applied, caught and reverted on earlier revisions before the owner changed the execution rule. This does not establish mutation coverage of the current revision; it needs run at merge.
