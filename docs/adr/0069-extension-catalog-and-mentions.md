# 0069: Provider extension catalogs and structured mentions

Date: 2026-10-07. Status: accepted for implementation.

## Context

The command palette only described commands. It could not preserve the identity of a selected skill, app, plugin or agent inside a message. Provider extension discovery also differs by harness and by account. A catalog must describe what is installed without suggesting that an unavailable native capability can be invoked.

ADR 0002's local CLI and credential boundaries, ADR 0003's schema-only protocol, ADR 0039's command ownership, and ADR 0061's permission isolation remain binding. This change covers the daemon, adapters, protocol and fake daemon. Composer menus and transcript chip rendering follow in the UI implementation.

## Decision

Extend `@ace/commands`; do not add another filesystem scanner. `catalog.list` accepts either a readable thread or an owned draft, a query, a limit and an optional subscription. Its `requestId` identifies both the initial `catalog.list.result` and later `catalog.changed` snapshots. `catalog.unsubscribe` ends that subscription; disconnect ends all subscriptions. Each read and push checks current authority, including draft ownership after asynchronous work.

Entries contain an opaque ID, kind, name, description, optional icon, provider/scope/path/plugin provenance and a discriminated invocation descriptor. Kinds are skill, command, plugin, agent, workflow, mcp-tool and builtin. `unavailable` descriptors retain discoverable metadata and explain why selection cannot be sent. `action` descriptors dispatch existing client actions or `automation.run`; they are not prompt mentions. Existing `commands.list` and `commands.resolve` remain available.

Messages gain a `ContentPart` variant with `type: mention`, `entryId`, `name`, `kind`, optional icon, positional arguments and structured prompt values. Prompt invocation descriptors expose the existing argument schema. The client supplies display metadata and the selected ID. The daemon resolves the ID again for the current provider instance, project and session. A supplied invocation descriptor is never trusted. File selections retain their IDs when native metadata subsequently supplies the effective definition; app IDs stay stable across cold and session reads. Missing, shadowed, disabled and foreign entries fail before provider input is sent. The original parts are admitted and stored unchanged, so native expansions and echoes cannot replace the person's chips. Existing persisted input identity correlation is retained.

Native translation is provider-specific:

- Codex receives native `skill` and `mention` input parts, including `app://` identities.
- OpenCode receives native skill IDs and agent mention ranges. Selected commands use `session.command`; several commands make separate ordered admissions carrying the complete message. Failure after an earlier admission is uncertain, not a safe rejection to replay.
- Claude receives explicit Skill-tool requests, named delegation requests and named plugin/MCP-tool instructions. Custom command files share Claude's Skill surface. This is a request to the agent, not proof that a model executed a tool.
- ACP and Pi receive one native prefix admission per selected slash command, carrying the complete message as context. ACP's existing queue still waits for child work and shell settlement. Several selections can therefore create several provider turns.
- Custom prompts, Cursor command files and ace skills expand through the existing prompt owner. Providers without a public typed reference API receive explicit instructions for agents, plugins and tools.

Selection position does not determine execution syntax. Multiple mentions can occur between ordinary text parts. Only prefix-only harnesses move command execution to a prefix; the original transcript retains the selected positions.

## Discovery and precedence

Harness metadata is preferred: Claude read-only `plugin list --json`, initialization, `supportedCommands`, `supportedAgents` and `commands_changed`; Codex `skills/list`, `app/list`, `mcpServerStatus/list` and update notifications; OpenCode command/skill/agent/plugin/MCP list APIs and update events; Pi `get_commands`; ACP `available_commands_update`. A successful active-session list is authoritative for its surface. File-only entries absent from that list remain discoverable with an unavailable descriptor. Different native surfaces replace independent partitions, and closing one session cannot remove another session's entries.

Filesystem fallback covers Claude skills/commands/agents, Codex skills/custom prompts/TOML agents, OpenCode command and agent config plus definition directories, Cursor skill/command/agent directories, Pi skills/prompts and ace prompts/skills. Shared project `.agents/skills` roots are included for Codex and OpenCode. Only definition files are cataloged; auth files, marketplace executable code and credential stores are not inspected. OpenCode config parsing retains command and agent definitions, not provider or MCP configuration.

Claude personal skills override project skills; skills override legacy command files. Claude subagents and the other local definition scopes use project precedence. Plugin names remain namespaced. Installed enabled Claude plugins and loaded plugins are identified by the harness registry; their standard component directories supply descriptions and paths. ace plugin metadata comes from the existing plugin manager and uses the existing projection names. MCP server status rows are unavailable for direct invocation and direct users to their tools. MCP tools enter the catalog only with real advertised tool identities; a configured server name is not fabricated into a tool name.

## Cache and bounds

Keep the existing eight-context workspace/instance cache, adding provider and home identity to its key. Cold catalog reads return existing entries immediately with `stale: true`, while definition scanning and optional harness metadata refresh asynchronously. Relevant filesystem changes, harness updates and ace plugin/automation mutations invalidate cached metadata. Metadata watchers inspect filenames and never open credential-bearing settings/configuration. Cold Claude registry reads use only the CLI’s public plugin-list command. Cold Codex metadata is obtained from initialization and read-only list methods, with no thread start, resume, authentication call or prompt. It uses only the selected registered instance's environment; removed accounts and injected fixture accounts never borrow an ambient login.

Catalog subscriptions are bounded per connection and globally. Metadata is bounded to 512 entries; serialized snapshots stay below 512 KiB. Existing secure filesystem containment, depth, node, file-byte and retained-catalog limits remain in force. Cold discovery admits at most eight pending probes and runs one subprocess at a time. Reads and native update refreshes coalesce; updates arriving during an in-flight native read cause another read. File watchers and processes are closed by the existing resource owners. No performance budget is raised.

## Limits and verification

Permission isolation can prevent ambient Claude plugins or Pi extensions from loading; this catalog does not relax the policy. Only loaded native plugins and advertised extension commands are claimed to be native. Cursor's pinned SDK has no public extension-list or typed plugin-reference API, so definition files supplement its available surfaces. Codex's experimental plugin list/read methods are not used; stable app/skill/tool metadata is used instead. OpenCode hook plugins have no explicit plugin invocation and are represented accordingly. Native APIs may expose only an effective definition and omit its original scope; file metadata fills provenance where it can be matched.

Marketplace installation, credentials, account login and plugin enablement remain with their existing owners. This is not a marketplace crawler. Standard loaded plugin directories are scanned within a bounded budget; nonstandard component locations depend on harness advertisement. No live provider prompts or recorder sessions were run. Scratch homes, synthetic definitions, real local processes, HTTP/WebSocket boundaries and reopened SQLite verify precedence, invalidation, account scoping, native input and retained mentions. The full suite is left to the merge orchestrator as requested.

Primary-source research and the UI contract are recorded in [the extension catalog brief](../research/providers/extension-catalog.md).
