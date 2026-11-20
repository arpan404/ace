# 0044: Consume the official ACP registry for local agents

Date: 2026-10-02. Status: Proposed.

ace should support any user-approved, locally installed stdio ACP v1 agent through its generic adapter. Consume the official ACP registry for distribution metadata, add ace-owned compatibility profiles, and adopt the official TypeScript SDK behind ace's bounded transport. [Provider research](../research/providers/acp-registry.md) records pinned sources, installed versions, initialize-only probes and the SDK limitations behind this proposal.

## Context

The official [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry) publishes a versioned index with binary, npx and uvx distributions. Zed now uses it for external-agent installation. A separate ACP docs catalog includes agents without registry entries. ace's integration branch already has a generic ACP translator, but discovery, accounts and session setup still assume a few providers. Details and schema citations are in the [registry findings](../research/providers/acp-registry.md#upstream-registry-schema-and-provenance).

Registry membership cannot guarantee correct agent-tree status, supported model selectors or isolated logins. The installed Qwen 0.0.14 and current Qwen source differ in launch flags, authentication and MCP/session capabilities. The Claude and Codex bridges default to bundled underlying CLIs unless overridden. SDK 1.7.0's stable stdio connection lacks ace's admission bounds and parses session updates through a closed union. The [source and probe findings](../research/providers/acp-registry.md) distinguish these observations from proposed behavior.

ADRs 0002, 0003, 0004, 0006, 0007 and 0010 remain binding. Provider processes and credentials belong on the user's machine; canonical completion must account for all known work; raw data stays lenient and bounded; the daemon supervises process trees.

## Final proposal for architecture review

### Distribution and installation

Add `@ace/agent-registry`. Its pure core decodes upstream manifests, selects platform distributions, matches profiles and builds installation plans. Its I/O shells fetch and cache bounded HTTPS catalog data and discover approved local installations through provider-kit. Use `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, schema version 1, rather than defining an ace distribution manifest or installing Zed extensions.

Retain the last valid catalog after refresh failures and keep installed agents usable offline. Store source URL, schema version, timestamp, content digest and available release identity. Verify artifact SHA-256 when provided and record package-manager integrity/provenance results. No signature contract exists in the inspected registry sources; do not label an unsigned HTTPS index as signed. Support future verifiable signatures if upstream offers them.

A refresh never executes code. Installation/update requires a concrete plan and an explicit owner-approved install intent. The plan names the publisher, exact package/artifact version, runtime, platform, integrity evidence, destination and argv. Use the user's selected package manager or approved binary download. Ordinary launches use the approved local artifact with no implicit runner download or automatic update. Keep installation versions stable across a live thread and explain unavailable versions during restart.

An agent outside the registry can use an explicitly approved local command/argv binding or a source-qualified third-party manifest compatible with upstream. Preserve unknown distribution metadata and show unsupported distributions as unavailable. Local overrides cannot impersonate an official entry.

### Agent identity and capability profiles

A registry entry describes a distributed agent. An installation identifies its local executable/version. An account instance identifies the user's CLI-owned config home and login revision. A compatibility profile describes ace's tested behavior for an agent/version. Keep these identities separate.

Use `provider: "acp"` plus `acpAgentId`, installation and instance references for arbitrary agents. Preserve existing native providers and Cursor/Antigravity identities during migration. Persist the ACP identity in thread, model and account metadata so several ACP agents never share caches or restart as the wrong tool.

Profiles contain local launch/version probes, login hints, verified home strategies, underlying CLI overrides, selector dialects, extension negotiation and bounded lifecycle quirks. Runtime support is the intersection of advertised features, implemented ace callbacks and profile safety restrictions. Retain the raw capability response. An unknown version gets standard negotiated ACP behavior with a "Generic ACP, best effort" label and explicit visibility limitations. Reserve "Verified profile" for exact version ranges with recorded behavior coverage; source-only profiles stay labelled as such.

Known child work, human interactions, surviving shells and unconfirmed completion continue to block done status and queued prompts. ACP interoperability cannot manufacture visibility for work the agent hides. Clients must show that visibility limit.

### Local authentication and accounts

ace never accepts provider secrets or hosts login flows. Discovery uses safe status commands where supported, otherwise auth remains unknown. Direct the user to the agent's own CLI login/configuration command in a local terminal using the same instance environment. Do not call ACP authenticate during discovery; it can clear credentials, write settings, open browser login or do nothing depending on the agent.

Approved bridge installations must use the user's resolved underlying CLI. For current Claude bridge profiles set `CLAUDE_CODE_EXECUTABLE`; for Codex set `CODEX_PATH`. Carry the selected native config home and supervise the entire process tree. Fail with a missing-CLI result rather than falling back to bundled provider binaries.

Extend the existing accounts service with profile-owned home strategies. Additional accounts require verified isolation, including credential-store behavior. Generic agents can use their default local home but cannot claim account isolation or migration. Newer Qwen's `QWEN_HOME` cannot be applied to old Qwen by assumption; Gemini's `GEMINI_CLI_HOME` path inconsistency needs verification. No credential files are read or copied by the registry service.

### Session setup, models and MCP

Initialize before choosing resume, model/mode dialect and MCP transport. Update effective capabilities before accepting dependent commands. Remove the unconditional MCP-style `initialized` notification from the current ACP session. Use actual config option IDs and values; use standard `session/set_mode` when modes are advertised, including on generic agents. Profile-gate legacy/unstable model setters and known no-op restrictions. A successful no-op model setter, such as the inspected OpenHands method, cannot establish model-switch support.

Amend ADR 0036's blanket generic ACP empty-session model discovery. Only profiles with a reviewed metadata-only session path may create an empty discovery session. Unprofiled agents populate selectors from the first user-authorized real session, or expose catalog unavailable and keep their CLI default. Never test entitlement through inference. Cache by agent installation, account instance, login revision and profile revision.

Append ace's ephemeral MCP definition during new/load session when that method permits `mcpServers`. Reuse `@ace/mcp-server` leases and injection helpers. HTTP requires an advertised HTTP capability. For stdio-only agents, add an ace-owned supervised stdio MCP bridge to the same loopback server. Preserve configured servers, detect name collisions and revoke leases on every session/process termination path. Redact lease material before raw frame persistence. Until a compatible bridge exists, expose MCP unavailable for that agent.

Filesystem and terminal client capabilities stay false until actual callbacks are implemented. MCP spawn acceptance remains an intent, not proof of a started or completed child.

### Official SDK and resource ownership

Pin the reviewed official `@agentclientprotocol/sdk` release, initially 1.7.0, accepting its Apache-2.0 license. Use its stable public types, method constants and client request/response API. Keep experimental ACP v2 and network transports outside this change.

Supply a custom ace `Stream` over provider-kit's supervised process, bounded framing and drain-aware writer. Capture original frames with secret redaction before normalization. Route raw `session/update` notifications through ace's existing lenient translator and session routing, outside the SDK's strict session router. Avoid SDK session helpers that retain update queues. Use public custom-handler parser overloads for vendor requests; preserve unknown messages as raw facts.

Admit requests, incoming handlers and every queued/in-flight byte before the SDK creates unbounded pending entries or write promises. Metadata deadlines close the connection and stop the process if the peer ignores cancellation. Prompt interruption still uses `session/cancel` and waits for definitive settlement. Preserve final stdout drain, replacement-process isolation, interaction expiry and process-tree shutdown.

Keep the existing `JsonRpcPeer` live path until the replacement passes the behavior gates in the research. If the public SDK cannot meet them, adopt its types/constants and retain the bounded peer with an explicit upstream blocker. No private SDK imports, fork or copied SDK implementation.

## Consequences

The registry adds agent breadth without changing the native Claude/Codex/OpenCode defaults. New agents can work immediately through standard ACP, while profile work improves fidelity independently of registry updates. Distribution provenance and tested behavior remain separately visible.

The implementation touches protocol identity, discovery, adapter sessions, accounts, models, MCP and daemon assembly. It adds a supervised stdio MCP bridge and a guarded SDK transport migration. Real provider fixture recording is a separate owner-approved action because it spends quota. The accompanying implementation is a review candidate; this decision remains Proposed until the owner accepts it through PR architecture review. No turn-level provider verification or fixture recording is claimed.

## Implementation candidate and adoption gate

The main-based candidate adds one public `@ace/agent-registry` API, daemon service registration, correlated registry wire requests and a client SDK method. It preserves native adapter defaults, the OpenCode version gate and Cursor's ACP fallback. Main now includes `@ace/accounts` from integration train 2. ACP account schemas and SQLite summaries retain the complete agent/installation/instance identity, installation/profile metadata and login revision. Default ACP instances share the user's existing CLI environment; a shared default home is not an isolated account. Unverified selectors and generic migration return unsupported. `AccountService.acpEnvironment` supplies the selected environment and generation; the optional daemon `acpEnvironment(identity)` hook remains for explicit local configuration. `AccountService.loginAcp` resolves a reviewed CLI command through the approved registry and inherits terminal streams without capturing authentication. Unknown profiles have no login plan. The native accounts paths remain available.

Profile coverage is exact-version source evidence for Gemini 0.43.0, Qwen 0.0.14/0.24.7, Claude bridge 0.85.1, Codex bridge 2.1.1, Goose 1.53.0 and Auggie 0.36.0. Custom Kiro/OpenHands bindings and other entries use standard generic negotiation; unprofiled legacy setters remain disabled. Modern Qwen's home feature is not applied to old Qwen. Claude/Codex bridges require an approved installed native executable and force its environment override. The Claude/Codex bridge profiles offer canonical `clientCapabilities.subagents` and the reviewed `nativeSubagentSessions` metadata fallback, and require the agent's matching canonical or metadata advertisement. This opts into child sessions only; source-profile labels and limited visibility remain. The contracts were reread at [Codex's pinned subagent docs](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/docs/subagent-sessions.md) and [Claude's pinned extension docs](https://github.com/agentclientprotocol/claude-agent-acp/blob/686c0c99b3b89217b74d1f5de8272e7c9ef1aab4/docs/air-extensions.md#native-subagent-sessions). Generic agents expose unknown auth and limited visibility. Filesystem and terminal callbacks remain unavailable.

SDK 1.7.0 is pinned with Apache-2.0 accepted in NOTICE. Only stable public root method constants/protocol version are adopted. Its stable Connection still has uncapped pending/handler/write-promise ownership, cancellation does not remove pending requests locally, and the default session-update router rejects unknown variants before custom handling. The shipped ndJSON stream eagerly drains input. A public custom Stream does not solve the Connection's admission and parser ownership. These are explicit upstream blockers, so the bounded `JsonRpcPeer` remains the live route; no SDK connection, session builder, private import or copied transport is introduced. Request admission now also caps incoming handler lifetimes at 128 and can stop requests while retaining final stdout observation. Integration train 2 requires certified provider payloads; ACP redacts before constructing that certificate. The peer framing maximum remains 16 MiB, while certification admits at most 1 MiB per persisted provider frame.

Registry bounds are 4 MiB responses, 2,048 entries, 64 KiB per entry, one refresh, 24-hour TTL and 512 local installations. Icons are retained as URLs without fetching. Installation supports raw binary, ZIP and gzip tar distributions, exactly pinned npm packages and uv packages pinned to entry version. bzip2/platform installers are unavailable. Package-manager output is bounded and discarded rather than exposed as potentially secret progress text. npm records its generated lock integrity; uv records manager/package provenance without a hash claim. The inventory publishes only after preparation succeeds. Persistence enters a noncancellable commit phase before rename: cancel returns false during that phase, and shutdown drains it. A typed post-publication durability error preserves the referenced artifact and returns success with `durability: "uncertain"`; it cannot trigger deletion of a committed installation. Custom inventory storage must distinguish such errors with `CommittedWriteError`. Crash-left private directories cannot launch and are not silently overwritten. Entrypoint hashes do not claim to revalidate the full dependency tree on every launch.

Negotiation replaces unconditional initialized/load/model assumptions. Config IDs and dependent option replacements are session-derived; HTTP MCP follows advertisement and stdio MCP uses a supervised loopback bridge. Supplied user servers are preserved and name collisions fail visibly. Lease substrings are redacted in values and property names, with collisions preserving every field, before certified raw payloads and metadata callbacks; leases expire on startup failure, exit and shutdown.

The owner explicitly forbids tests, probes, benchmarks, mutation execution and full `bun run check` during this implementation. Verification uses the permitted static checks; protocol reference artifacts are regenerated from the schemas; all runtime claims need execution at merge. [Verification](../../packages/agent-registry/VERIFICATION.md) lists synthetic/replay suites, planned mutation cases and deferred performance measurements. [Recording scenarios](../research/providers/acp-registry-recording-plan.md) are definitions for separate approval, not authorization to run a provider.

### Owner decision still required

The implementation brief explicitly requires owner architecture acceptance before treating this ADR as accepted. This review pass finalizes the proposal and supplies the accounts integration and bilateral negotiation previously missing. It retains the bounded peer because the SDK ownership gates remain unsolved. PR #64 is the concrete architecture review endpoint. No owner acceptance has been recorded, so this ADR and the ADR 0036 amendment remain Proposed; completing the code changes does not fabricate that approval.

## Amendment: Antigravity accounts in managed homes (2026-10-22)

The "Local authentication and accounts" section allows extra accounts for an agent once its home and credential store are verified. Antigravity is the first verified profile.

**Evidence.** Antigravity's ACP server documents `GEMINI_HOME` as the root of its consumer token, business token and `settings.json` (`<home>/antigravity-acp/acp_token.json`). It reads and writes the token through one store. On macOS that store is the login keychain under a fixed account name (`gemini` / `antigravity-acp`) for every home, unless `AGY_ACP_FORCE_FILE_STORAGE` is set, in which case it uses only the token file under the home. Off macOS it always uses the file. The `agy` CLI keeps a separate keychain login and is not involved.

**Decision.**

- A managed Antigravity account is an `acp` account of ace's Antigravity installation (`official:antigravity-acp`, `antigravity-cli`). It has `managed: true`, `homeStrategy: "managed"` and the one stored selector `GEMINI_HOME`, its private home under `<dataDir>/account-homes/<id>`. Its process environment adds `AGY_ACP_FORCE_FILE_STORAGE=true`, so its login never reads or replaces the keychain login. ace only chooses the folder. The agent alone reads and writes credentials there, as with Cursor's file store in ADR 0018.
- The CLI's own login stays a `default_cli` account with the person's environment and is never removed.
- Profiles live in `@ace/accounts` (`acpManagedHome`). An agent without one cannot have an added account. A stored selector that differs from the profile's is refused.
- Sign-in runs Antigravity's ACP `authenticate` inside the account's home, after validating that home. A thread on an added account opens through `AccountService.openSession`, like a native account. The home is validated first. The session is counted, so a sign-in change stops it before the credential changes. Removal waits for it. New sessions are fenced while the account is pending or changing. A thread whose account is gone is refused, never moved onto another login.
- An account of ace's Antigravity installation serves the provider `antigravity` (`accountProvider`, shared by the daemon, clients and fake daemon), so account selection, switches and the model picker match it to Antigravity threads and models. Another installation of the same agent stays an ACP agent of its own.
- Each ACP agent has its own default account (`provider:acp:<agent>`), the CLI login until the person chooses another.
- An added account's model catalog is registered only once it is signed in, validates its home before each discovery, and carries no sign-in method. A lapsed login is reported rather than starting a browser sign-in. The declared `agy /usage` source reads the CLI's default login and is not applied to added accounts.

Other agents stay single-account until their own home and credential store are verified the same way.

## Amendment: unprofiled agents choose models (owner, 2026-11-19)

The decision above profile-gates the legacy/unstable model setter, and leaves "unprofiled legacy setters remain disabled". The owner lifts that gate. Every ACP agent, with or without a compatibility profile, now offers a model picker when its session lists models. That includes profiles with `legacyModel: false` (Qwen 0.24.7, Goose 1.53.0, Auggie 0.36.0). Old Qwen's `denySelectors` still turns every selector off.

**Rule.** A session's model is chosen through its standard `configOptions` model selector and `session/set_config_option` when it has one. Otherwise ace uses the legacy `models: {availableModels, currentModelId}` list and `session/set_model`. The model catalog lists the same models for an unprofiled agent, with `selectorMethod: "session/set_model"`. The profile's `legacyModel` flag no longer gates selection.

The owner treats this as a security matter. The legacy path is the agent's own unstable surface, so it runs under these rules:

- **Only listed ids are sent.** ace sends only a model id the agent listed in this session's setup or a later reply. A free-form value, or one known only from the catalog or another session, is refused before anything is written to the agent.
- **A selection is never claimed against the agent's word.** A reply naming another current model (a `models.currentModelId` or a model config option) means the selection did not apply. ace reports it as refused: at start the daemon posts its notice and the thread runs the agent's default, and a later change fails without the thread recording the new model. ACP's `session/set_model` reply has an empty schema, so an empty reply counts as applied. A setter that answers success but changes nothing, such as OpenHands' no-op, still can't be detected; this rule doesn't claim it can.
- **Lists are decoded leniently and bounded.** A malformed entry (no id, an id that isn't a string of 1–256 characters, a duplicate) is skipped. The rest of the list still works. A list over 512 entries offers no picker and the catalog lists no models for it. The session goes on at the agent's default. Nothing in the list can fail a session or a catalog refresh.
- **A rejected setter is off for the session.** If the agent answers `session/set_model` with any JSON-RPC error (method not found, or a refusal), the legacy picker is turned off for the rest of that session. The thread stays on the agent's default model, the daemon posts its "didn't take model …" notice, and a diagnostic note `acp-legacy-model-rejected` is recorded. A standard `configOptions` model selector, if the agent later reports one, still works.
- **Labels are display-safe.** Model names drop control, bidi (overrides and isolates), zero-width and other format characters, and line and paragraph separators; a name left empty shows the id. A model id containing any of those characters is never offered, in the picker or the catalog, because ids go back to the agent unchanged and can't be cleaned.

Code: `listedModels`, `displayLabel` and `sessionSelectors` in `packages/agent-registry/src/selectors.ts`; `AcpConfiguration.select` in `packages/adapter-acp/src/configuration.ts`; `normalizeAcp` in `packages/models/src/normalize.ts`.

## Amendment: agents that update themselves (owner, 2026-11-19)

Gemini CLI, the Claude and Codex bridges (and the native CLIs they drive) and auggie update themselves. Under the rules above, every update stopped every thread on that agent until the person approved it again, approving again made a new installation identity that stranded the old threads, and an agent one patch past its profile's version lost its profile and with it every access mode. The owner decided to keep the approval gate and remove the stranding.

**The gate stays.** A launch hashes the approved executable (and a bridge's native CLI) as before. If either differs from what was approved, ace doesn't run it, ever, until the person approves. The refusal names the agent and the action: "<agent> changed since you approved it, so ace won't run it. Approve the update in Settings → Providers to keep using it."

**Approval in place.**

- The registry listing (`registry.list`, first page) checks every installation against its approval by hashing only (a stat each while unchanged; nothing runs) and reports each changed one in `updates`: its identity, what changed (`agent`, `native_cli`) and the digests on disk now.
- `registry.approve-update` approves those exact digests for the same installation identity. The digests in the request must match the files on disk at approval: a file that changed again after the person looked is refused ("review the update again"), and an approval of files that already match is refused, so an approval can't be replayed. The request may carry the version the client knows; otherwise the recorded version stays. The profile revision is recomputed from the new version.
- The installation keeps its `acpAgentId`, `installationId` and `instanceId`, so its threads, their saved sessions and their accounts carry on. Each approval appends `{ approvedAt, previousVersion, version, previousExecutableDigest, executableDigest, previousBridgeDigest?, bridgeDigest? }` to the installation's `approvals`; the newest 16 are kept.
- Only the person approves. Approval requests (`registry.bind`, `registry.install-intent`, `registry.approve-update`) need admin scope, and an agent's own device (`ace-agent`, `ace-reviewer`: the CLI in an agent's shell, ace's agent tools) is refused whatever its credential's scopes. No MCP tool or agent-control operation reaches the registry, and nothing approves automatically. As for every person-only action on the host token (ADR 0178 §12.5), this guards against honest agents. A process that reads the token and claims to be another device is the boundary ADR 0190 covers, and this amendment doesn't change it.
- Settings → Providers shows each waiting update in a "Waiting for your approval" group, one sentence and an "Approve update" button. The phone's Add agent screen shows the same rows.

**Profiles cover a version range.**

- A profile keeps the exact version it was verified on and may declare a compatible range (`compatible.below`, exclusive). The default range is the verified version's major version, from the verified version up. A prerelease of the verified version is older than it, so it's outside. An unreadable version fits only exactly.
- The profile for a version is the one verified on it (`profileFit: "verified"`), else the profile in range verified on the newest version not above it (`profileFit: "compatible"`). A compatible match keeps the profile's selectors, access-mode table and bridge behaviour. The session leaves an `acp-version-unverified` note naming the profile, its verified version and the version running.
- Negotiation applies the same rule to the version the agent reports at `initialize`. In range, the profile stays (`acp-version-changed` with `runsAs: "profile"`). Outside it, the session runs as generic ACP (`runsAs: "generic"`) and offers no profile-only access modes.

## Amendment: models before the first thread (owner, 2026-11-19)

A generic ACP agent had no model catalog row until one of its threads opened a session, so a newly added agent showed no models and no access offers in the picker. Its row's identity also hashed the session's working folder, so a thread in another project counted as another identity and deleted the cached row. The owner decided to list an agent's models before its first thread.

**Decision.**

- **One row per agent and account, in every project.** The working folder is no part of an ACP row's identity. A row an older build wrote with its folder in the identity is kept while its revision (agent, installation, account instance, login and profile revisions, installed version) still matches; the next write stores the new identity. Nothing is rewritten at open.
- **Rows at daemon start, with no launch.** Each approved installation gets its catalog row at start from the stored inventory alone: no process, digest or probe, bounded by the inventory. An agent installed while the daemon runs gets its row at install. Antigravity's installation keeps its own provider and rows. The agent's default account (its CLI login) is registered the first time ace needs it, as before.
- **A restart serves the cached row.** A restored ACP row is never refreshed by the restart, the background revalidation tick or a sign-in. Its sessions keep it current, as before.
- **The probe.** Loading a row before a thread opens runs a metadata-only probe: `initialize`, then `session/new` with no MCP servers, then selecting each listed model to read its options (configuration only). It never sends `session/prompt` or `authenticate`, and the process stops at once. It opens in ace's own folder, `<dataDir>/acp-model-probe`, made when a probe starts, never in a project.
- **When it runs.** An agent with a reviewed compatibility profile is probed once, the first time a picker or `models` listing reads a row that has never loaded. An unprofiled agent keeps this ADR's rule against unasked empty sessions: it is probed only when the person asks for that agent's models, a `models.refresh` naming its own row (the picker's Load models). A refresh of every model or every ACP agent does not start it. Either way the result is cached, and an agent that lists no models is cached as a loaded, empty row, not retried.
- **Folder trust.** ace grants the probe folder no trust: it sets no trust variable and writes no trust file. Gemini CLI hides its privileged approval modes in a folder it does not trust, so a Gemini probe in an untrusted folder keeps its models but stores no modes. The row then offers no access modes until a session in the person's project reports them. A folder the person trusts (directly or through a parent) is honoured, and the probe's modes are kept.
- **Protocol.** `ModelInstanceStatus.modelProbe` (`automatic` or `on-request`) tells clients which rule applies, so a picker can offer Load models for an unprofiled agent that has not loaded.

**Tightening (2026-11-19, review of the probe).** These replace the "When it runs" and "The probe" rules where they differ.

- **Only the person starts an agent for its models.** Load models sends `models.load` with the row's id. The daemon admits it only from a socket that proved the person's standing (ADR 0190) and never from an agent's device. `models.refresh`, which any operate device may send, starts no ACP agent: it resets the row, as a sign-in does.
- **The first start is the person's.** An agent starts the MCP servers its own configuration names when a session opens, and ace can't turn that off. So even a reviewed agent's row waits for Load models (it reports `modelProbe: on-request` until then). Once it has loaded in this run, by Load models or a session, a read may load it again when it is reset or empty. Startup, timers and refresh still never probe.
- **Attempts are spaced.** One probe per row per minute, whatever asks. A failing row keeps its retry pause, and nothing resets it.
- **The row follows the agent.** Approving an update re-registers the row with the approved version, executable and profile. A version outside the profile's range turns it on-request and drops the previous version's models. Before `session/new`, a reviewed row's probe checks that the approved launch is still the row's version and profile, and that the version `initialize` reports still has that profile.
- **The row follows the login.** A login change observed on the account, such as signing out in the agent's own CLI, drops the previous login's models and modes before the row is served again.
- **No lasting selection.** The probe switches models to read per-model options only for Antigravity, and selects the original model again at the end. Other agents may keep a switch (Cursor saves its model), so they list the current model's options only.
- **A folder per probe.** Each probe opens in its own new folder inside `<dataDir>/acp-model-probe`, removed once the agent stops.
- **Capacity.** The catalog holds 512 ACP rows beside 64 CLI accounts, live and cached, matching the registry's 512 installations, so an approved agent never silently loses its row. Start registers rows in one pass over the inventory.
