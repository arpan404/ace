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

SDK 1.7.0 is pinned with Apache-2.0 accepted in NOTICE. Only stable public root method constants/protocol version are adopted. Its stable Connection still has uncapped pending/handler/write-promise ownership, cancellation does not remove pending requests locally, and the default session-update router rejects unknown variants before custom handling. The shipped ndJSON stream eagerly drains input. A public custom Stream does not solve the Connection's admission and parser ownership. These are explicit upstream blockers, so the bounded `JsonRpcPeer` remains the live route; no SDK connection, session builder, private import or copied transport is introduced. Request admission now also caps incoming handler lifetimes at 128 and can stop requests while retaining final stdout observation.

Registry bounds are 4 MiB responses, 2,048 entries, 64 KiB per entry, one refresh, 24-hour TTL and 512 local installations. Icons are retained as URLs without fetching. Installation supports raw binary, ZIP and gzip tar distributions, exactly pinned npm packages and uv packages pinned to entry version. bzip2/platform installers are unavailable. Package-manager output is bounded and discarded rather than exposed as potentially secret progress text. npm records its generated lock integrity; uv records manager/package provenance without a hash claim. The inventory publishes only after preparation succeeds. Persistence enters a noncancellable commit phase before rename: cancel returns false during that phase, and shutdown drains it. A typed post-publication durability error preserves the referenced artifact and returns success with `durability: "uncertain"`; it cannot trigger deletion of a committed installation. Custom inventory storage must distinguish such errors with `CommittedWriteError`. Crash-left private directories cannot launch and are not silently overwritten. Entrypoint hashes do not claim to revalidate the full dependency tree on every launch.

Negotiation replaces unconditional initialized/load/model assumptions. Config IDs and dependent option replacements are session-derived; HTTP MCP follows advertisement and stdio MCP uses a supervised loopback bridge. Supplied user servers are preserved and name collisions fail visibly. Lease substrings are redacted in values and property names, with collisions preserving every field, before certified raw payloads and metadata callbacks; leases expire on startup failure, exit and shutdown.

The owner explicitly forbids tests, probes, benchmarks, mutation execution and full `bun run check` during this implementation. Verification uses the permitted static checks; protocol reference artifacts are regenerated from the schemas; all runtime claims need execution at merge. [Verification](../../packages/agent-registry/VERIFICATION.md) lists synthetic/replay suites, planned mutation cases and deferred performance measurements. [Recording scenarios](../research/providers/acp-registry-recording-plan.md) are definitions for separate approval, not authorization to run a provider.

### Owner decision still required

The implementation brief explicitly requires owner architecture acceptance before treating this ADR as accepted. This review pass finalizes the proposal and supplies the accounts integration and bilateral negotiation previously missing. It retains the bounded peer because the SDK ownership gates remain unsolved. PR #64 is the concrete architecture review endpoint. No owner acceptance has been recorded, so this ADR and the ADR 0036 amendment remain Proposed; completing the code changes does not fabricate that approval.
