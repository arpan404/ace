# Mutation cases

Current revision: **not executed (tests run at merge)**. Each case names a production change and the public behavior test designed to kill it. No production mutation is left applied.

| Mutation                                             | Guarding behavior                                                                       | Status                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| Remove insertion offsets                             | Follows an insertion above a comment                                                    | not executed (tests run at merge) |
| Keep deleted findings active                         | Keeps the last position when selected lines disappear                                   | not executed (tests run at merge) |
| Disable fuzzy fallback                               | Matches small edits using surviving context and asks for review                         | not executed (tests run at merge) |
| Choose the first ambiguous destination               | Does not guess between identical destinations                                           | not executed (tests run at merge) |
| Keep changed findings active                         | Matches small edits using surviving context and asks for review                         | not executed (tests run at merge) |
| Corrupt suggestion replacement text                  | Applies a suggestion through git                                                        | not executed (tests run at merge) |
| Invert the requested resolution                      | Comments, replies and resolution survive reopening                                      | not executed (tests run at merge) |
| Bypass reviewer validation                           | Reviewer output rejects malformed comments                                              | not executed (tests run at merge) |
| Emit oversized excerpts                              | Fix payloads cap excerpts and aggregate size                                            | not executed (tests run at merge) |
| Replace disk SQLite with memory                      | Comments, replies and resolution survive reopening                                      | not executed (tests run at merge) |
| Forget terminal daemon receipts                      | Review ids deduplicate ordinary commands                                                | not executed (tests run at merge) |
| Replay unknown receipt recovery                      | Receipt recovery never starts an unknown effect                                         | not executed (tests run at merge) |
| Serialize reads behind an awaiting reviewer          | Reviews remain readable while a reviewer is waiting                                     | not executed (tests run at merge) |
| Remove admission backpressure                        | Excess work gets backpressure                                                           | not executed (tests run at merge) |
| Retain old text inside a changed long selection      | A small insertion refreshes text outside the transition hunk; deletion removes old text | not executed (tests run at merge) |
| Treat a zero-count hunk coordinate as a line         | Zero-context insertions/deletions map after the caret                                   | not executed (tests run at merge) |
| Match deleted content to unchanged duplicates        | Deleted text cannot attach to identical unchanged context                               | not executed (tests run at merge) |
| Advance the revision of an unplaced finding          | Unrelated changes preserve an outdated finding's last revision and position             | not executed (tests run at merge) |
| Remove deletion offsets                              | Follows a deletion above a comment                                                      | not executed (tests run at merge) |
| Ignore renamed paths                                 | Follows a file rename, including metadata-only renames                                  | not executed (tests run at merge) |
| Remove aggregate fix-intent byte cap                 | Fix payloads reject excessive aggregate size                                            | not executed (tests run at merge) |
| Terminalize a busy recovery response                 | Saturated retry preserves the waiting reviewer's successful receipt                     | not executed (tests run at merge) |
| Keep a fresh busy reservation forever                | A command rejected before admission can retry after capacity returns                    | not executed (tests run at merge) |
| Omit workspace validation                            | Identical filenames in two repositories cannot reach the wrong executor                 | not executed (tests run at merge) |
| Omit canonical worktree validation                   | Same-workspace target must use the reviewed worktree                                    | not executed (tests run at merge) |
| Omit source identity from executor intents           | Selected structured fixes carry source workspace and host worktree                      | not executed (tests run at merge) |
| Finish close before executor cleanup                 | Worker close stays pending after worker exit until abort cleanup settles                | not executed (tests run at merge) |
| Terminate the worker without draining Git            | Closing the worker kills the live Git parent and descendant                             | not executed (tests run at merge) |
| Persist cancellation as terminal rejection           | Interrupted execution still requires recovery after restart                             | not executed (tests run at merge) |
| Remove counter cache eviction                        | Public resource usage remains capped after new checkpoint namespaces                    | not executed (tests run at merge) |
| Reload an evicted counter as zero                    | Checkpoint sequence increments durably after eviction                                   | not executed (tests run at merge) |
| Return absent pagination records                     | Next page contains the saved second id and then exhausts                                | not executed (tests run at merge) |
| Drop EOF metadata or patch markers                   | Unterminated EOF/context suggestions preserve actual file bytes                         | not executed (tests run at merge) |
| Ignore human EOF termination edits                   | Newline edit conflicts without rewriting the file                                       | not executed (tests run at merge) |
| Bundle review's worker-relative entry                | Bundled CLI serves review commands and durable retry receipts                           | not executed (tests run at merge) |
| Treat restored outdated findings as already reviewed | Unique reinsertion across multiple refreshes becomes pending review                     | not executed (tests run at merge) |

Historical evidence: the first twelve mutations were applied, caught and reverted on earlier revisions before the owner changed the execution rule. This does not establish mutation coverage of the current revision; it needs run at merge.
