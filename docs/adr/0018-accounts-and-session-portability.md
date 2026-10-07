# 0018: Provider accounts, quota and session portability

Date: 2026-10-02. Status: accepted.

## Context

Users can exhaust one subscription while other subscriptions still have capacity. A session must retain its full native history when moved. The competitor inventories describe t3code account selection and pooled usage, Codex thread forks, Claude parallel sessions, and Cursor handoffs. They do not establish a safe cross-account lineage-copy contract. ace needs explicit instance identity and migration safety rather than treating a provider as one global login.

ADR 0002 applies. Accounts are local provider-runtime homes, including official SDK default stores under ADR 0043. ace never reads auth files, accepts a credential, or copies credentials. Provider research in `docs/research/providers/` and primary provider sources define the supported formats; competitor implementations are not used.

## Decision

Add `@ace/accounts`, with pure quota folds and scheduler policy, a small SQLite registry, CLI login/discovery shells, and streamed migration I/O. An instance is `{id, provider, label, homeDir, env}`. IDs are caller supplied. Homes must be absolute, physically distinct, local directories. Registration is asynchronous so canonicalization through existing ancestors never holds a SQLite transaction across filesystem I/O. Historical lexical identities are normalized on open; physical duplicates refuse startup. Persist only allowlisted directory selectors, never arbitrary environment variables. Build process environments from the instance and the caller's environment, removing provider auth overrides so ambient credentials cannot silently defeat account selection. The sole Cursor SDK exception inherits the launch environment's `CURSOR_API_KEY` for that selected backend; never persist its value or apply this exception to ACP or other providers.

Codex uses `CODEX_HOME`. Claude uses `CLAUDE_CONFIG_DIR`. OpenCode uses XDG data/config/state/cache roots, with the actual provider home at `XDG_DATA_HOME/opencode`. Cursor ACP uses `CURSOR_DATA_DIR` for session data and `CURSOR_CONFIG_DIR` for login/config, confirmed by the installed hidden `--data-dir` flag and provider research. Cursor's default macOS keychain is global even when the data/config directories change. Isolated instances therefore select the CLI's native `AGENT_CLI_CREDENTIAL_STORE=file` and private HOME/XDG/APPDATA roots under the instance. Only the CLI reads or writes that credential store. Existing Cursor keychain logins are not imported; the user logs into each isolated instance through the CLI. These are instance configuration, not provider credentials. Discovery finds conventional sibling homes without opening auth files. Login probes reuse provider-kit single-provider discovery under instance environments; unrelated CLIs are never executed. `ace accounts add` runs the installed CLI's interactive login with inherited terminal streams, then probes status. It records an unknown-auth account before login so a cancelled login can be retried. An injected supervised spawner inherits terminal streams without capturing them, owns the process group, and escalates cancellation to SIGKILL after a bounded grace period, waiting for child termination before reporting cancellation.

Cursor SDK is the default for new Cursor threads when the exact supported package is installed. SDK sign-in is separate from CLI/editor login. Use official `Cursor.auth.login/status/logout` in supervised isolated Node hosts with HOME set to `<instance.homeDir>/user` before SDK import. The SDK owns `<instance.homeDir>/user/.cursor/sdk/auth.json`; discard login's key-bearing return inside the worker and publish only safe status/source plus authorized ephemeral login URLs. The default SDK credential store is used for both login and Agent execution. Never set apiKey in an ace request or serialize the environment key into IPC. Sign-out fences sends, drains admissions, stops and awaits all selected-instance hosts, then calls SDK logout and verifies auth.json is absent without reading its contents. Keep conversation state/history. Writer reservations remain held on failed host exit. Environment authentication stays active until the user removes its launch value; dashboard revocation is separate. SDK checkpoints are not ACP stores, and native conversion/cross-account checkpoint copying is unsupported; use a bounded ace-owned portable context handoff with provenance and declared loss. Windows SDK home/sandbox ownership remains unsupported until verified.

Quota snapshots retain at most 32 named windows per instance, separate local overflow/text-limit blockers, and the latest sanitized usage counters. Provider names cannot overwrite local blockers. Unknown Claude statuses and malformed Codex sibling windows preserve known constraints; complete authoritative snapshots alone replace the window set. Provider frames are parsed leniently, and the ingest result returns the original raw fact to its caller, including unknown variants. Raw frames are never persisted in the account registry. Unknown/resetless exhausted windows stay blocked until fresh facts arrive. A window expires at its reset instant. Older updates cannot overwrite newer state. Logout takes precedence over quota, and successful login does not erase limits. A usage-limit clock string is interpreted in an explicit IANA timezone, using the next occurrence and rejecting ambiguous/nonexistent civil times conservatively.

`pickInstance({provider, role, estimatedLoad})` selects a logged-in, available instance with enough headroom. Estimated load is percentage points, not tokens. Prefer the earliest active window reset; tie-break on headroom and instance ID. Near-limit accounts are excluded. Role policy requests speed, while capability data decides whether a model supports it: Codex `model/list.serviceTiers` must advertise `priority`; Claude fast mode must be explicitly supported for the chosen model. No catalog is guessed.

## Migration and safety

The engine must stop the source tree, release its provider process, and hold a quiescence lease for every copied native session through publication. `migrateSession` requires an injected lease boundary. It must also exclude independent provider processes; absence of a lock file alone does not prove inactivity. The daemon supplies a fail-closed policy when independent-writer exclusion is unavailable. `AccountService` reserves both homes against new ace starts and checks its bounded active-writer index; these reservations do not exclude independently launched CLIs. Provider locks and read-only process samples cannot exclude future independent starts atomically. Therefore default daemon migration refuses rather than treating absence of a writer as proof. A verified offline embedding can inject the required safety lease. Failed lease release keeps the service reservations blocked. Migration checks Codex `thread-writer-locks/<id>.lock` for every ancestor and refuses even stale locks. This avoids modifying the source to probe or clean up locks. Claude callers must exclude live foreground/background writers and sidechains through the same lease. No automatic migration runs while work is active.

For Codex, discover rollouts by metadata, not only filename. Walk all `forked_from_id`, `parent_thread_id`, and differing root `session_id` references with a bounded graph and detect cycles/missing ancestors. Copy the full files under their native relative paths. Legacy JSONL is supported initially. Inventory errors are recorded per native ID, so unrelated compressed, malformed or duplicate archived histories do not disable healthy legacy migration. Compressed, paginated and `history_base` rollouts on the selected lineage return `unsupported`: those formats require provider-owned materialization and SQLite projections, and copying an account-wide database would overwrite unrelated destination sessions. Validate compatibility with installed `codex exec fork <id>` without a prompt in an empty synthetic home.

For Claude, copy the project JSONL and all files under its `<id>/subagents/` directory, preserving the project slug. Resume uses the original native ID in the destination. OpenCode export/import is promising but its documented export does not establish complete child/permission fidelity or writer exclusion. Cursor ACP uses `acp-sessions/<id>/store.db`, and resume/fork support is incomplete. Both return `unsupported` with a reason rather than claim full-history migration.

Every source file is streamed into a private staging directory on the destination filesystem. Reject symlinks, traversal, special files and overlapping homes. Existing destination files are reused only after streaming SHA-256 verification proves they match the source exactly; conflicting files are refused. This permits sibling forks to share already migrated ancestors and makes retrying an interrupted operation safe. Check source stat fingerprints and locks again before publishing. Atomic hard-link publication prevents overwrites and exposes only complete files; publish ancestors and sidechains before the root. On failure, roll back files created by this operation. A host crash can leave complete orphan ancestors or staging directories, never a partial root transcript. Optional bounded `cleanupWarnings` preserve the operation outcome when lease release, rollback or staging cleanup fails. Async copy/staging observers provide backpressure and deterministic verification of source-change guards. Multi-file publication is not a filesystem transaction. Callers serialize migration with destination sessions through the lease. ace never writes source bytes or metadata; normal filesystem read access times may advance.

## Protocol and wire additions

Add schema-only account definitions in a new protocol file and an additive `./accounts` export. Requests and responses cover `accounts.list`, `accounts.status`, and `accounts.migrate`; login and home registration stay host-local CLI operations. Public snapshots contain ID, provider, label, auth and quota, not paths or environment. A migration response reports `migrated`, `unsupported`, or `refused` and a safe reason. The existing wire unions include the new schemas through additive option spreads. Authenticated daemon routes invoke `AccountService`, enforcing the merged remote-access scopes (`read` for list/status, `operate` for migration). The daemon CLI delegates `ace accounts` to the accounts command shell, avoiding competing bins; eight in-flight account requests per connection bound pending work. The daemon and accounts CLI share `$ACE_HOME/accounts.sqlite`, with an optional `ACE_ACCOUNTS_DB` override. `SessionContext.env` carries the selected environment to adapters; `AccountService.openSession` binds quota observations and writer lifetime to that instance. `bindAdapter(factory, assignmentFor?)` produces an ordinary `ProviderAdapter` for engine registration, invoking the native factory only after environment selection. The factory receives selected context for per-instance model resolution and MCP/plugin/context composition by those feature owners. `ProviderSession.instanceId` is persisted with the native ID and supplied on resume; unpinned resume refuses. Natural exit and completed close revoke the selected session lifetime, releasing lifetime-bound resources. Pending engine and adapter workstreams must register these factories and propagate encoded-frame certificates; their combined execution needs run at merge.

## Security

No provider credentials cross ace storage or the wire. Login output goes directly to the user's terminal and is not captured. No shell interpolation. SQLite and staging files use private modes. Session transcripts can contain secrets, so copies stay under user-owned local homes with private permissions. Paths never come from a remote request. Native IDs are validated before filesystem access. Unknown provider raw facts stay with the adapter's existing raw-data policy, not a second unbounded log here.

## Performance

Provider ingress requires a `ProviderPayload` parsed from at most 1 MiB of encoded bytes before JSON parsing or object enumeration. Its owned data is immutable, with a 32,768-node cap and iterative traversal so deeply nested unknown native fields remain admissible within those bounds. No arbitrary-object certification path exists. Uncertified quota maps are blocked without enumeration; service frames require the certificate and exact data identity before forwarding or quota folding. Invalid frames fence the session and initiate awaited shutdown. A failed shutdown retains its writer reservation. Within that enforced byte budget, quota decoding inspects at most 32 entries plus overflow lookahead and retains at most 32 windows. Transport owners must bound buffers while collecting encoded lines/SSE. Payload admission and certified forwarding have dedicated non-gating benchmarks; new measurements need run at merge under the owner policy. Stream deltas take O(1) work and bypass SQLite when they contain no quota fields; registry size is capped at 256 instances. Window overflow installs a resetless exhaustion marker until a bounded authoritative snapshot arrives. Scheduling scans at most that cap and only on assignment. Single-account status uses its prepared lookup rather than scanning other accounts. Reuse prepared SQLite statements. File discovery and lineage planning are cold paths with explicit file/depth limits; copy streams use fixed-size buffers and sequential backpressure. Benchmarks measure quota folding, scheduling, adapter delta forwarding, persisted updates and streaming migration plus peak RSS. No history scan occurs on stream deltas.

## Testing

Public API tests use temporary SQLite homes and executable fake CLIs for account-specific discovery/login. Synthetic native rollouts cover depth-three lineage, missing/cyclic ancestors, format refusal, locks, live lease refusal, destination collisions and unchanged source hashes. Claude tests cover root transcripts and sidechains. Quota tests cover both provider payload families, unknown payloads, stale updates, multiple windows, logout, resets, timezone midnight/DST and limit strings. Scheduler tests cover reset ordering, exhausted/near-limit exclusion, headroom and supported speed tiers. Under the current repository-owner rule, behavior tests and mutation cases are written but not executed before merge. Final runtime validation, benchmarks and mutation checks need run at merge; static checks alone run in this follow-up. Real CLI verification never sends a prompt or runs the recorder.

## Primary references

- [Codex provider research](../research/providers/codex.md), including rollout/session metadata and thread-store source paths.
- [Claude provider research](../research/providers/claude-code.md) and [fast mode](https://code.claude.com/docs/en/fast-mode).
- [OpenCode provider research](../research/providers/opencode.md) and [configuration](https://opencode.ai/docs/config/).
- [Cursor provider research](../research/providers/cursor.md) and [CLI configuration](https://cursor.com/docs/cli/reference/configuration).

## Amendment: accounts managed from Settings

Accepted 2026-10-04 for the owner's multiple-account request. This supersedes the
host-local registration restriction in "Protocol and wire additions". ADR 0002
continues to govern authentication. The app opens a terminal for the installed
provider's own local login flow. ace does not implement OAuth, accept credentials,
or read provider credential files. Cursor uses the official SDK exception in
ADR 0002 and the supervised hosts in ADR 0043 when that backend is selected.

`accounts.add` accepts only provider and label. The daemon generates the ID and
creates a private, mode-0700 home at `<dataDir>/account-homes/<id>`. Persist only
instance metadata and directory selectors. Managed instances also isolate HOME,
XDG cache/config/data/state, APPDATA and temporary files so incidental CLI writes
stay in the private home. Pi uses `PI_CODING_AGENT_DIR`; its sign-in status remains
unknown because no verified provider-independent status probe exists.

`accounts.rename`, `accounts.remove` and `accounts.setDefault` update the registry.
Removal unregisters by default. Only `deleteHome: true` permits deleting a
daemon-created home, after checking the parent and home are direct directories,
not symlinks. Host-registered homes can be unregistered, but cannot be deleted or
used for app-initiated auth. Active writers and auth jobs prevent removal and
other conflicting account changes. Defaults persist per provider and affect new
assignments. Existing pinned sessions keep their account. Removing a selected
account falls back to the implicit CLI account.

Every native provider has an implicit `<provider>-cli-default` account labeled
"Default (your CLI login)". These records use the daemon's launch environment
and point to the CLI's existing normal home. Registration creates no directory
there. The app cannot rename, remove, sign into, sign out of, or migrate these
accounts. The user manages their normal login directly through the CLI.

`accounts.login` and `accounts.logout` return `accounts.auth` with a terminal ID.
The terminal belongs to the requesting socket. The client subscribes with the
existing `terminal.request` API and omits `threadId`. Launch waits for that first
subscription so no browser challenge is lost before the UI is ready. Auth
terminals use the existing PTY process ownership and shutdown service, with
explicit executable arguments. They have no scrollback, snapshots, event-log
entries, or replay. Output is forwarded only to that live authorized socket.
Disconnect cancels the terminal and awaits process cleanup. Input is never
written to an ace log or history. Pi requires the client to display the returned
`/login` or `/logout` instruction in its terminal.

Codex runs `codex login` or `codex logout`; Claude runs `claude auth login/logout`;
OpenCode runs `opencode auth login/logout`. Cursor ACP runs `agent login/logout`
only for the already verified isolated CLI release. Cursor SDK auth fences and
drains the instance's hosts before launching a PTY-owned helper that invokes the
existing supervised SDK auth driver. The SDK host discards key-bearing returns.
Only its ephemeral browser URL reaches the terminal. After exit and process
cleanup, refresh safe sign-in status and replace only that instance's model
catalog generation. Metadata discovery sends no prompt or inference request.

Account mutations and auth terminal access require the local owner connection,
a desktop connection, or the explicit `accounts` pairing scope. `operate` and
remote `admin` alone do not grant this scope. Pairing defaults remain read and
operate. Existing Cursor browser-auth mutations require the same accounts scope,
so they cannot bypass this policy. Read-only account listing still requires read.

The backend exposes `accounts.changed` with the updated public summary, or null
after removal. Public summaries include `implicit` and `isDefault`, never home
paths or launch environments. The fake daemon implements the same lifecycle and
catalog behavior. Socket behavior tests use controlled executable CLIs, temporary
homes and local paired devices. They verify isolation, status/model refresh,
default persistence, deletion choices, immutable CLI accounts and authorization.

Primary command references: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Codex CLI](https://developers.openai.com/codex/cli/reference),
[OpenCode auth](https://opencode.ai/v2/docs/cli/commands/),
[Cursor CLI auth](https://docs.cursor.com/en/cli/reference/authentication), and
[Pi quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md).

### Amendment: managed-home admission and cancellation ownership

Managed home identities remain lexical and immutable after registration. Registry
restart rejects a changed canonical identity instead of adopting a symlink target.
Before auth, status, SDK auth, session admission or metadata discovery, validate
the direct child of the injected daemon data root and its directory selectors,
including HOME/XDG directories. Inspect directory metadata only, never credential
files. The same accounts-owned validator serves every launch boundary. Filesystem
validation and process launch are separate system calls; concurrent hostile local
filesystem mutation is outside this guarantee.

Auth startup is owned from reservation through discovery and fencing. Disconnect
aborts its per-terminal signal and awaits startup cleanup before releasing the
account. A cancellation check immediately before terminal admission prevents a
successful late fence from launching the helper. Model deletion retains a shared
per-instance removal promise and every discovery generation until cleanup settles.
Storage failures are reported only after draining processes, remain retryable,
and cannot authorize home deletion while cleanup is outstanding.

These changes satisfy ADR 0002 through provider-owned auth and directory metadata
validation. The UTF-8 decoder holds at most an incomplete character; it creates
no auth history, capture, replay or persisted output. Review regressions and
mutation cases are written but not executed under the owner's merge-time testing
rule. Runtime, process-effects and benchmark measurements need run at merge.

### Amendment: implicit accounts and existing execution admission

Adding an implicit account is a catalog operation. Its unknown sign-in status
must not disable the existing normal CLI execution path or the conductor's
`local.<provider>` account identity. Without an explicit selection or provider
default, native execution keeps that path when there are no registered isolated
accounts. Where registered accounts exist, preserve their quota-aware selection;
an implicit home with no quota observations cannot displace them. An explicit
provider default or pinned session still takes precedence. Cursor SDK continues
to use its separate registered home and cannot use the implicit CLI login.
Delegation and conductor admission therefore distinguish registered accounts
from implicit records instead of treating every listed home as a scheduler candidate.

A metadata discovery guard that rejects a changed home also revokes that account's
cached model choices. Ordinary provider discovery failures may retain stale
choices for a valid home. Removal waits for cancellation cleanup, so callers and
test discoverers must release owned I/O before awaiting removal. Session opening
failure preserves undelivered input in a paused queue with a visible error, as in
ADR 0053. These admission changes preserve ADR 0002: no new credential inspection
or provider authentication runs on the implicit home.

### Amendment: normal-profile sign-in from first-run setup

The owner's one-click sign-in request permits the new `provider.login.*` and
`provider.logout` service to authenticate the implicit native CLI account under
`operate` authority. It preserves the normal launch environment and home, so the
terminal CLI uses the resulting login. Explicit managed profiles remain supported.
These requests do not change the existing `accounts.*` authority or allow renaming,
removing or migrating implicit accounts. SDK identity, fencing and isolated default
stores remain governed by ADR 0043. Browser challenges are device-owned and ephemeral;
only a per-device onboarding dismissal flag is persisted by first-run setup.
