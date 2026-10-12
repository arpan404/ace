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

## Process and provider control

```
ace stop --json
ace kill-all --provider claude --json
ace capabilities --json
ace providers status --json
ace login codex --stream jsonl
ace login claude --json
ace mcp enroll --scope read --ttl 1h --project WORKSPACE
ace mcp list --json
ace mcp revoke ENROLLMENT --json
```

`stop` waits for a correlated cleanup receipt and reports cleanup failures. A closed
listener alone does not prove shutdown completion. `kill-all` records cancellation;
subsequent waits return failed with the cancelled thread IDs. Provider and project
filters apply to every terminated thread. `--thread` selects its subtree.
Without filters it also stops owned supervised groups. Retrying its key returns the
receipt and does not terminate a later generation. Unfinished receipts are uncertain.
The shared process supervisor journals kernel start identity, owner identity and
non-secret labels in `processes.sqlite`. Startup kills verified orphan groups;
recycled or unverifiable live groups fail closed. Existing terminal guardians retain
PTY session ownership and already clean up on daemon death.

MCP enrollment is a separate loopback `/mcp` endpoint built on ace's existing MCP
server. Its lease identity is external and grants no internal agent impersonation.
Read leases expose bounded project inspection. Operate adds thread starts/messages
and delegated task control. Neither exposes approvals or administration. TTL is at
most 24 hours; revoke aborts active tools, and restart invalidates all bearers.
Only local host administrators can enroll/list/revoke. Enrollment writes the ace
bearer to a private 0600 file. The setup command loads `ACE_MCP_TOKEN` from that file;
Claude and Codex config reference the variable. The paste-ready commands and config
contain no token literals. Revocation and expiry remove the current credential file.
Launch the provider from the shell where the variable is exported. JSON output also
includes the ace bearer once. No provider credential is read or persisted.
The snippets use [Claude HTTP MCP configuration](https://code.claude.com/docs/en/mcp)
and [Codex HTTP MCP configuration](https://developers.openai.com/codex/mcp).

Login uses the reviewed supervised native CLI device/browser flow. Verification
URLs and device codes go to stderr, or typed JSONL records. Providers without an
SSH-compatible reviewed flow return needs-human with native terminal instructions.
ace cancels and drains an active supervised session before printing fallback
instructions, so a new login can start immediately.
The CLI never accepts provider API keys or performs a token exchange.

## Server and remote profiles

```
ace serve --json
ace service install --linger --json
ace pair redeem - --name "SSH client" --profile workstation --json
ace remote add workstation https://host:4243/ --fingerprint SPKI_SHA256 --device DEVICE_ID --token-file /private/device-token
ace remote list --json
ace remote use workstation
ace threads list --json
ace thread read THREAD --remote workstation --json
ace remote use local
ace remote remove workstation
```

`serve` runs the daemon without a desktop and selects the headless browser backend.
`service install --linger` uses Linux `loginctl enable-linger` for the invoking user
so the user service survives logout. It refuses other operating systems.

Pipe the one-time pairing URL into `pair redeem`; the host chooses device scopes.
Redemption consumes it once, validates its SPKI pin and saves only ace device access.
`remote add` requires an explicit HTTPS origin, SPKI pin, device id and private token
file, and confirms pinned ticket exchange before storing the profile. `remote list`
hides tokens. Profile names have separate SDK outboxes and host bindings. Removal
clears selection, not the daemon's device registration; `devices revoke` owns that.

The active profile selects WebSocket work commands. `--remote NAME` overrides it;
`--remote local` selects the local host token. Runtime, service, enrollment, pairing,
cloud wrappers and local log files are local operations. Use a registered workspace
id when starting work on a remote profile. Each connection exchanges its device
token for a fresh ticket before pinned WSS hello. No provider credentials enter a
profile or the SDK outbox.

## Cloud, logs, browser and automations

```
ace cloud codex exec "Review the repository" --env ENV_ID --idempotency-key review-cloud --json
ace cloud codex list --json
ace cloud codex status TASK_ID --json
ace cloud codex diff TASK_ID --json
ace cloud codex apply TASK_ID --json
ace logs -f --json
ace browser shot THREAD --url https://example.com --output shot.png --json
ace browser record THREAD --duration 10s --output recording.mp4 --json
ace automation list --json
ace automation run ID --variables '{"branch":"main"}' --json
```

Cloud commands invoke the installed, logged-in `codex cloud` in the current
checkout. JSON envelopes retain bounded native stdout, operation and exit status;
cloud execution success means submission succeeded. Status/diff/apply depend on
the installed Codex version. No provider HTTP API or credential store is added.
Exec/apply receipts prevent repeat submission after retries. A crash/timeout before
a receipt is uncertain and is never automatically resubmitted. Inspect the native
cloud task list before choosing a new key.

Logs read the local daemon's redacted JSONL with native tail rotation handling.
`-f --json` emits one typed log record per line until interrupted. Browser commands
reuse the thread's browser, origin approvals and ownership. Recording subscribes
and acknowledges frames, then finalizes through the browser owner. Artifacts are
downloaded through `@ace/client` even for remote profiles. Output files are created
exclusively; existing files are never replaced. Recording requires the daemon's
Chromium/ffmpeg prerequisites. Automation runs use the existing durable owner.

See [cloud CLI evaluation](../research/cli-cloud.md) for the other vendor wrappers
considered for this phase.
