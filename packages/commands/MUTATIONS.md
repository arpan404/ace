# Mutation cases

All cases below are **not executed (tests run at merge)**. Each describes a
production mutation and the public behavior test designed to kill it. The
final implementation, filesystem notifications and benchmark measurements
need run at merge.

| Production mutation                                               | Behavior test                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Remove required-argument validation                               | applies typed defaults, escaping and required validation without expanding inserted values |
| Disable argument type validation                                  | applies typed defaults, escaping and required validation without expanding inserted values |
| Expand escaped placeholders                                       | applies typed defaults, escaping and required validation without expanding inserted values |
| Allow provider mismatches                                         | preserves Claude metadata and leaves native context injection to Claude                    |
| Drop Codex `$ARGUMENTS` expansion                                 | expands Codex named and positional placeholders once and preserves escaped dollars         |
| Reverse workspace/user precedence                                 | merges multiple homes with workspace precedence without crossing accounts                  |
| Disable account filtering in list and resolve                     | merges multiple homes with workspace precedence without crossing accounts                  |
| Ignore usage ranking                                              | keeps the best fuzzy matches across heap replacements and returns them in rank order       |
| Remove runtime metadata bounds                                    | rejects oversized runtime metadata without replacing the current session catalog           |
| Suppress metadata recovery invalidations                          | repairs missed body edits in bounded batches without scanning all sources                  |
| Remove the 32-record recovery batch cap                           | repairs missed body edits in bounded batches without scanning all sources                  |
| Stop tracking absent roots                                        | recovers creation of a missing root without native notifications                           |
| Keep a cached definition for a nonregular entry                   | removes a cached snippet when its file becomes a nonregular filesystem entry               |
| Keep a cached config when it becomes a directory                  | removes cached OpenCode commands when their config file becomes a directory                |
| Complete a flush without draining changes queued during its batch | drains invalidations queued during a flush before the batch completes                      |
