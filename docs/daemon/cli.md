# Headless CLI

`ace` connects to the daemon in `ACE_HOME`, defaulting to the existing ace home.
Start it with `ace start` before sending work. Providers use your installed CLIs.

```
ace run "Fix the parser" --provider codex --project /path/to/repo --json
printf 'Review the diff' | ace run --provider claude --worktree --stream jsonl
ace threads list --json
ace thread read THREAD --json
ace thread send THREAD "Add a regression test" --idempotency-key followup-1
ace thread steer THREAD "Keep the public API unchanged"
ace thread wait THREAD --tree --timeout 10m --json
ace thread approve THREAD --interaction INTERACTION
ace thread deny THREAD --interaction INTERACTION
ace thread cancel THREAD
ace task spawn "Review the diff" --parent THREAD --provider claude --idempotency-key review-1
ace task status CHILD --json
ace task wait CHILD --timeout 10m --json
ace task cancel CHILD --idempotency-key cancel-review-1
```

`run` returns an admission and thread id. `--stream jsonl` also waits for the tree.
`--project` accepts a registered workspace id or a path. Paths register through
ace's existing project owner. `--worktree` asks that owner to prepare a worktree.
`thread read` returns the bounded live transcript window and its older-page cursor.
`threads list` returns the current bounded list window and pagination metadata.
A task is an independently owned delegated child of `--parent`, and its id is
its child thread id. Cancellation is acceptance of a cascade, not proof of exit.

All commands accept `--json`; `--jq EXPR` implies JSON and uses your installed jq.
The executable and filter syntax are checked before any command effects. Filter
evaluation can still fail on the returned data; retain mutation keys for retries.
JSONL streams have admission/status/event/outcome records. Waits return on a human
interaction so automation can hand back control. Supply `--interaction` when more
than one is pending. Approval defaults to allow-once; `--option` selects a native
option explicitly. Questions and elicitation require a suitable client.
Held input requiring intervention returns needs-human, uncertain delivery returns
uncertain, and queued input awaiting automatic resumption keeps the wait open.
Tree outcomes include authoritative queue metadata for each member. Unresponsive
task status returns uncertain. Interactive account login progress is shown as it
arrives, on stderr when JSON output is selected.

Exit codes: 0 successful operation, 1 failed work, 2 needs human input, 3 observation
timeout, 4 refused/invalid invocation, 5 uncertain outcome. A wait timeout leaves
work running. An acknowledgement timeout is uncertain; retry the identical mutation
with its printed idempotency key. The SDK persists pending commands before sending
and validates daemon identity before replay. No disconnect is treated as completion.
Never reuse a key with different input. Task receipts are scoped to their parent.
