# Delegation failure and stale network status

The installed desktop build at `84773d6d` failed delegation because its root
thread retained a durable Stop marker after a new person input restarted it.
The owner's daemon was inspected read-only. SQLite files were copied to a
throwaway directory for queries; the installed application, daemon and
`~/.ace-next` were never changed.

The recorded interrupt intent was accepted at `1791256873880`. A new person
send was accepted at `1791256878361` and started another native OpenCode
execution. The root still had a row in `delegation_subtree_stops` and
`delegation_trees.cancelled=1`. `DelegationAdmission.validate` therefore threw
`Error("cancelled")` before child preparation. This affected `delegate_task`,
`ace_spawn_agent` for both Claude and OpenCode, and `ace_thread_create`.
`toolFailure` exposed ordinary exceptions as `execution_failed`; no underlying
exception or actionable notice was recorded at this tool boundary.

A new accepted person send, parent follow-up, or explicit resume now clears
only the root's stop/cancel marker. Rejected and automatic inputs keep it.
Descendant stops, budget counters and elapsed-time accounting survive. A
cancelled child's late result stays readable but cannot wake the new root
turn. An explicitly reopened child can deliver results again. This is a
transactional journal change with one added `wake_suppressed` column. Migration
backfills existing stopped children so late results stay suppressed after an upgrade.

## Candidate checks

| Candidate              | Evidence                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model identity/default | The owner catalog contained canonical `claude-opus-5-5` and qualified `opencode-go/muse-spark-1.3-contributor`. The actual failure preceded model selection. The live sandbox selected Opus 5.5 successfully.                                                    |
| Account selection      | Claude and OpenCode had implicit CLI accounts, and the failing calls requested no managed account. Admission stopped before scheduling. Missing/mismatched accounts now return `account_unavailable`.                                                            |
| Provider enable state  | The cancellation rejection preceded provider launch. Disabled provider/account settings now return `provider_disabled` before discovery or creation.                                                                                                             |
| Admission              | The stop marker was the actual rejection. The evidence copy had two engine slots, two historical delegation receipts, zero reservations and zero children in the affected root. Capacity was not exhausted.                                                      |
| Worktree preparation   | No child/worktree was admitted. The shared cancellation check rejected all creation paths before filesystem preparation. Missing workspaces now return `workspace_unavailable`.                                                                                  |
| Claude CLI path        | No Claude launch was reached in the failing calls. The owner's installed CLI was present and usable in the isolated sandbox. Missing adapters now return `provider_unavailable`; the packaged environment was not modified or probed by attaching to its daemon. |

Authored failures now retain their diagnostic cause while agents receive only
fixed catalog messages and hints. The caller's thread receives a notice with
the same public code and a remedy. Diagnostics receive the operation, thread,
code, error, bounded stack and cause through the existing redactor. Unknown
exceptions still use `execution_failed`, with diagnostic detail and a notice.
No provider message or code-shaped object becomes a public error catalog entry.

## OpenCode network evidence

The root's `ECONNRESET` was an upstream OpenCode provider retry, not an ace MCP
connection failure. OpenCode's native retry event is the source of the network
status fact. The retained canonical status showed attempt 2 and a retry time;
subsequent native shell tool events and assistant text arrived on the same
local server connection while ace kept that old network status. The execution
eventually completed. The failure was a stale label during a recovered
execution, rather than a permanently failed server socket. The retained evidence
does not identify which remote socket reset.

OpenCode retries upstream requests itself. ace now clears a transient retry
when new text, reasoning, tool activity or streamed/completed model-step progress proves that the
same execution is advancing. Heartbeats and metadata do not prove recovery.
The existing local-stream reconnect/snapshot owner remains responsible for
SSE loss; ace does not replay model prompts to fix a connection reset. Live
children, tools, shells and human interactions continue to prevent completion.

The redacted owner fixtures contain the recorded interrupt/send intents and
public failure, plus canonical retry evidence and a recorded native tool
progress event. The fixture labels the retry envelope reconstructed from
canonical evidence, rather than claiming it is a raw recorded SSE frame.

## Verification

Before the fix, the root Stop/send/MCP creation regression returned
`execution_failed` instead of a child, and the same-execution OpenCode progress
regression stayed `waiting` instead of `working`.

Daemon process tests use the real daemon, temporary SQLite and Git repositories,
real HTTP MCP calls, and child processes running the existing fake provider
CLIs. They verify all six cross-provider directions among Claude, Codex and
OpenCode, wait results, idempotent retry, Stop/send recovery, legacy spawn,
create/launch/wait, public error isolation, notices and diagnostics. Further
behaviour checks cover late cancelled results, surviving descendant stops,
restart, rejected/automatic resumes, and local SSE reconnect without prompt
replay. Tests are run serially, only in the modified test files.

The live sandbox used `/tmp/ace-delegation-live-oYeAxA`, a throwaway Git repository
and a separate ace home. Installed `opencode v2.0.22` and
`Claude Code 2.1.286` used their existing CLI logins. The OpenCode root completed
a short prompt, was stopped, and completed a second prompt. Calling
`delegate_task` with `provider: "claude"`, `wait: true` and read-only permission
returned `HELLO_FROM_CLAUDE` with a completed child on `claude-opus-5-5`.
Repeating the request reused the same child. `ace_thread_create` for OpenCode
also succeeded; its unlaunched child honestly remained starting/waiting in the
parent tree. The sandbox daemon was closed afterwards.

The live proof spent three short prompts, and an earlier isolated probe spent
one, for four total out of the allowed fifteen. No fast mode was requested.
Native MCP registration and credential exposure are outside this change.

Formatting, lint, typecheck, source-size limits, dependency boundaries, UI-value
checks and the protocol documentation check passed. The daemon benchmark was
not run: every observed one-minute host load exceeded the owner's limit of 15
(the final recorded one-minute load was 251.34). A full `bun run check` was
not invoked because it runs untouched tests and the gated benchmark; only the
five changed test files were run, serially: 52 tests passed.
