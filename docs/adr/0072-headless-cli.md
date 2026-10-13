# 0072: Headless ace CLI

Date: 2026-10-11. Status: accepted for issue #552.

## Decision

The CLI complements the clients. Use noun/verb groups (`threads list`,
`thread send`, `task spawn`, `mcp enroll`, `remote use`) with short entry points
`run`, `start`, `serve`, `stop`, `kill-all`, `login`, `capabilities` and `logs`.
Packaged update, supervision and migration remain release-runtime commands.
Split parsing, output and each command group into small modules. Use `@ace/client`
for authenticated WebSocket commands, subscriptions and reconnect. Daemon owners
retain execution, delegation, process supervision, accounts and browser behavior.

Every command accepts `--json` and `--jq EXPR`. JSON output is one object or array
per operation; failures are `{ok:false,status,error}`. `--jq` runs the installed
jq against that JSON without a shell and implies JSON output. Streams use
`--stream jsonl`: one typed JSON object per line, including a final outcome.
Diagnostics and human progress go to stderr in machine mode. No ANSI in JSON.
Exit codes are 0 ok, 1 failed, 2 needs-human, 3 timeout, 4 refused and 5 uncertain. `ace start` exits 6 when another process holds its port, so the desktop app can say so.
Timeout stops observing, not accepted work. Disconnected or unresponsive work
never means success. Whole-tree waits use canonical daemon facts and check all
linked descendants before returning success; missing descendants stay uncertain.

Mutations accept `--idempotency-key KEY`; durable commands use it as Command.id.
Delegated tasks use the existing parent-scoped request receipt. Repeating the same
key and input returns the same admission, never a second provider run. Generated
keys are included in admission output. Keys must not be reused for different input.
The CLI persists the client's outbox privately with atomic indexed record writes;
crash recovery reuses the SDK's replay and host binding, not a new retry engine.

Local connections read the host token and endpoint from ACE_HOME. Remote profiles
store only ace device identity, device token, HTTPS origin and an explicitly
confirmed SPKI SHA-256 pin in a private file. Each reconnect obtains a single-use
WSS ticket over pinned HTTPS. Profiles never contain provider credentials.

External MCP enrollment is explicit, local-host administrative work. Each lease
has read or operate scope, optional registered project restriction, bounded TTL
and an opaque revocation id. Store only a digest of its ace bearer; revocation
aborts in-flight effects. Outside callers never claim an internal agent identity.
Read permits scoped discovery and inspection. Operate adds ordinary thread/task
control, never approval of provider permissions or administration. Enrollment
prints native CLI configuration snippets; it does not edit provider configs.
Restart invalidates ephemeral MCP bearers. Provider authentication stays in the
user's installed CLIs under ADR 0002, including supervised native device login.

## Delivery

Three PRs deliver headless work, process/MCP control, then remote/server helpers.
Behavior tests use real CLI processes and temporary daemon homes with scripted
provider boundaries. Per the owner, local verification is formatting, lint and
changed-workspace typechecks only. CI must run tests and the full merge gate.
