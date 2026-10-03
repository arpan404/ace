# 0043: Consume the official ACP registry for local agents

Date: 2026-10-02. Status: Proposed.

ace should support any user-approved, locally installed stdio ACP v1 agent through its generic adapter. Consume the official ACP registry for distribution metadata, add ace-owned compatibility profiles, and adopt the official TypeScript SDK behind ace's bounded transport. [Provider research](../research/providers/acp-registry.md) records pinned sources, installed versions, initialize-only probes and the SDK limitations behind this proposal.

## Context

The official [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry) publishes a versioned index with binary, npx and uvx distributions. Zed now uses it for external-agent installation. A separate ACP docs catalog includes agents without registry entries. ace's integration branch already has a generic ACP translator, but discovery, accounts and session setup still assume a few providers. Details and schema citations are in the [registry findings](../research/providers/acp-registry.md#upstream-registry-schema-and-provenance).

Registry membership cannot guarantee correct agent-tree status, supported model selectors or isolated logins. The installed Qwen 0.0.14 and current Qwen source differ in launch flags, authentication and MCP/session capabilities. The Claude and Codex bridges default to bundled underlying CLIs unless overridden. SDK 1.7.0's stable stdio connection lacks ace's admission bounds and parses session updates through a closed union. The [source and probe findings](../research/providers/acp-registry.md) distinguish these observations from proposed behavior.

ADRs 0002, 0003, 0004, 0006, 0007 and 0010 remain binding. Provider processes and credentials belong on the user's machine; canonical completion must account for all known work; raw data stays lenient and bounded; the daemon supervises process trees.

## Proposed decision

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

The implementation touches protocol identity, discovery, adapter sessions, accounts, models, MCP and daemon assembly. It adds a supervised stdio MCP bridge and a guarded SDK transport migration. Real provider fixture recording is a separate owner-approved action because it spends quota. This docs proposal contains no feature implementation or turn-level verification.
