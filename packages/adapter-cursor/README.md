# Cursor local SDK adapter

`@ace/adapter-cursor` implements ADR 0043 using exactly `@cursor/sdk` **1.0.35**.
It selects local execution by supplying `AgentOptions.local`; it never configures
a CLI/ACP endpoint or supplies an API key option. The owner-selected default
model is `composer-2.5`; an explicit thread model overrides it. ACP remains a separate fallback
and the continuation backend for existing Cursor ACP threads.

Public entry points are `createCursorAdapter`, `openCursorSession`,
`CursorTranslator`, `discoverCursorSdk`, `createCursorAccountDriver`,
`cursorSdkEnvironment`, `CursorHostSlots`, and bounded checkpoint snapshots.
The account driver runs official login/status/logout/catalog operations in
short-lived workers. The translator is synchronous and has no I/O.

## Admission and instance ownership

Discovery resolves the adapter's installed SDK and its own optional helper
package without importing the SDK into the daemon. Wrong versions, missing
helpers, unsupported platforms and setup failures refuse admission. Only package
absence permits ACP fallback. The host requires Node 24+, macOS/Linux arm64/x64;
Windows is explicitly unsupported pending verified home resolution and process
ownership.

Bind an adapter to `{ id, homeDir }`. Hosts receive HOME/USERPROFILE
`<homeDir>/user` before SDK import. The SDK default auth store is therefore
`<homeDir>/user/.cursor/sdk/auth.json`. SDK imports and their five-second credential
cache remain inside the selected instance's host. The launch environment's
`CURSOR_API_KEY` is inherited only for this backend and never sent through IPC.
SDK browser sign-in is separate from CLI/editor login; ace has no key-entry UI.
Login returns only safe status/source. Its ephemeral URL callback belongs to an
authorized login UI and never to recorder/event storage.

Logout first invokes the injected instance fence. That fence drains in-flight
admissions, awaits disposal/confirmed process exit, and refuses to release account
writer reservations on failure. The auth worker then calls SDK logout and checks
file absence without reading credentials. It preserves checkpoint/history data.
Logout does not revoke a key in Cursor's dashboard, and environment authentication
remains active until removed from the launch environment. Rebuild the signed-out
adapter owner after successful sign-in. See the [accounts integration](../../docs/integration/cursor-sdk-accounts.md).

## Policy and controls

Full access disables sandbox. Restricted mode enables sandbox plus Auto-review
and fails closed unless a trusted owner explicitly establishes Auto-review
availability. There is no implemented classifier availability probe, so the
default restricted admission currently refuses with an actionable setup notice.
Live verification of Auto-review and sandboxed MCP remains pending approval.

Capabilities expose sandbox-only approvals, interrupt/restart steering, context
handoff forks, read-only children and partial background visibility. There is no
question/plan-review callback, native fork, independent child send/resume/stop, or
custom-tool escape from policy. Native SDK retries are disabled; only authoritative
SDK error classes establish auth/quota/network failures, and no retry is invented.
Root interruption disposes/stops the entire host, including work that outlived
the run handle; a later send opens a pinned checkpoint continuation. Steering
cancels only its segment and retains the live host for replacement.

The daemon issues thread/instance-scoped HTTP MCP leases through `@ace/mcp-server`.
Because inherited task MCP headers do not prove which child made a call, this
initial daemon composition grants read capabilities only, including to the root.
Mutating ace MCP operations stay denied until caller identity is established.

## Replay, steering and recovery

Every admitted frame has schema version, sequence/time/direction, operation,
generation, segment and observed native identities. The daemon persists sanitized
SDK envelopes alongside canonical ace events. One logical operation retains one
ace run through cancelled/restarted SDK segments; late old root frames cannot
settle the replacement. The existing durable engine intents retain input and
fence ambiguous dispatch after restart instead of resending it automatically.

For local 1.0.35, onDelta is the live content source; the SDK-generated stream
messages and terminal result are overlapping observations. Ordered segment
provenance prevents duplicate text without text equality. Task call IDs own
provisional child nodes and late native identities link to them. Background
dispatch does not settle a child. Missing lifecycle evidence becomes visible
uncertainty before a root turn ends. Deeper nested/tool/shell/edit visibility is
incomplete; shell deltas without authoritative call association remain raw notices.

New threads use Cursor's public transactional SQLite checkpoint store under the
private SDK home, separately for each ace thread. Existing SDK JSONL checkpoints
retain their format. Partial or conflicting formats refuse recovery and preserve
the source. CLI JSONL histories are never SDK checkpoints.

A bounded, redacted callback journal is fsynced before IPC. ace commits each
boundary offset in the same SQLite transaction as its canonical facts. Restart
hydrates the pure translator from committed frames and replays only uncommitted
journal entries. Identical text from separate turns remains distinct. SDK durable
ObserveRun offsets have their own cursor; Send/onDelta positions never feed it.
Native run records reconcile interrupted runs before `Agent.resume`; a daemon
crash produces a clear interrupted/uncertain outcome, retaining input without an
automatic resend. Unique unclaimed native agents can be recovered; ambiguous
identity is refused. Native store cancellation is not proof of remote inference
cancellation, so surviving execution remains visibly uncertain.

Resume validates native checkpoint revision and positional snapshot identity in
a bounded worker before opening the live host. Snapshots and missing native
message observations remain reconciliation evidence, never guesses at new
canonical content. Missing, torn or oversized recovery refuses with an explicit
context-handoff action. Explicit `thread.create.handoffFrom`
starts a fresh agent using bounded ace-owned text/file/tool context, preserving
the source and exposing truncation. No opaque ACP/SDK store is copied.

## Bounds and verification limits

Defaults: 8 live hosts, 256 MiB old space each, 1 MiB IPC frames, 2 MiB pending
IPC/callback and retained-tool-argument bytes, 32 callbacks, 2,048 identities, 256 KiB input/body admission,
8 MiB checkpoint inventory, 100 snapshot items and 30-second worker operations.
The daemon also admits at most 32 outstanding SDK inputs per thread, with a
256 KiB input budget before persistence. Both daemon admission limits are injectable.
Inject limits, spawner, Node entry, environment, clock and identity sources at
public boundaries. Reuse `CursorHostSlots` across session/auth/catalog owners.
Provider-kit owns process groups, framed ingress, byte admission and graceful
termination. Parent pipe EOF terminates the owned POSIX group even when SDK
cleanup hangs. Tool/unknown bodies exceeding admission fail visibly and cancel;
admitted large raw data uses the daemon's existing ADR 0006 blob owner.

Checkpoint inventory gates the SDK's full-conversation load before pagination.
Native store writes and journal appends have byte/inventory gates and visible
failure fences; symlink ancestors are refused. A failed budget stops the host and
retains its checkpoint. Old-space limits bound JS heap, not helper/native RSS.
The SDK can buffer internally, and disk admission can discover growth after a
native write. Resource limits and parent-death behavior need run at merge; they
are not measured guarantees.

Behavior tests, non-gating delta/IPC/checkpoint benchmarks and synthetic process tests are
written but **not executed** under the owner's merge-only rule. No SDK model turn,
login, recorder, fixture, benchmark or mutation was run. See
[verification and pending recordings](../../docs/integration/cursor-sdk-verification.md).
