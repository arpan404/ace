# 0069: Provider extension catalogs and structured mentions

Date: 2026-10-07. Status: accepted for implementation.

## Context

The command palette only described commands. It could not preserve the identity of a selected skill, app, plugin or agent inside a message. Provider extension discovery also differs by harness and by account. A catalog must describe what is installed without suggesting that an unavailable native capability can be invoked.

ADR 0002's local CLI and credential boundaries, ADR 0003's schema-only protocol, ADR 0039's command ownership, and ADR 0061's permission isolation remain binding. This change covers the daemon, adapters, protocol and fake daemon. Composer menus and transcript chip rendering follow in the UI implementation.

## Decision

Extend `@ace/commands`; do not add another filesystem scanner. `catalog.list` accepts either a readable thread or an owned draft, a query, a limit and an optional subscription. Its `requestId` identifies both the initial `catalog.list.result` and later `catalog.changed` snapshots. `catalog.unsubscribe` ends that subscription; disconnect ends all subscriptions. Each read and push checks current authority, including draft ownership after asynchronous work.

Entries contain an opaque ID, kind, name, description, optional icon, provider/scope/path/plugin provenance and a discriminated invocation descriptor. Kinds are skill, command, plugin, agent, workflow, mcp-tool and builtin. `unavailable` descriptors retain discoverable metadata and explain why selection cannot be sent. `action` descriptors dispatch existing client actions or `automation.run`; they are not prompt mentions. Existing `commands.list` and `commands.resolve` remain available.

Messages gain a `ContentPart` variant with `type: mention`, `entryId`, `name`, `kind`, optional icon, positional arguments and structured prompt values. Prompt invocation descriptors expose the existing argument schema. The client supplies display metadata and the selected ID. The daemon resolves the ID again for the current provider instance, project and session. A supplied invocation descriptor is never trusted. File selections retain their IDs when native metadata subsequently supplies the effective definition; app IDs stay stable across cold and session reads. Missing, shadowed, disabled and foreign entries fail before provider input is sent. The original parts are admitted and stored unchanged, so native expansions and echoes cannot replace the person's chips. Existing persisted input identity correlation is retained.

Native translation is provider-specific (revised 2026-10-17, see "Skill delivery" below):

- Codex receives native `skill` and `mention` input parts, including `app://` identities. A skill item is preceded by its documented `$name` marker.
- OpenCode receives native skill IDs and agent mention ranges. Selected commands use `session.command`; several commands make separate ordered admissions carrying the complete message. Failure after an earlier admission is uncertain, not a safe rejection to replay.
- Claude, ACP and Pi receive one native prefix admission per selected slash command or skill (`/name args`, Pi `/skill:name args`), carrying the complete message as context. Claude text-only admissions are sent as a prompt string because Claude Code dispatches commands from the start of the prompt. ACP's existing queue still waits for child work and shell settlement. Several selections can therefore create several provider turns; every admission is correlated to the one stored message.
- Claude agents, plugins and MCP tools, and the same kinds on providers without a typed reference API, receive explicit named instructions. This is a request to the agent, not proof that a model executed a tool.
- Custom prompts and Cursor command files expand through the existing prompt owner. Skills without a native route are injected (below).

Selection position does not determine execution syntax. Multiple mentions can occur between ordinary text parts. Only prefix-only harnesses move command execution to a prefix; the original transcript retains the selected positions.

## Skill delivery

A selected skill must reach the agent as its instructions, never as bare `/name` text or a request the model may ignore. The daemon picks one route per mention in `@ace/commands` (`mentions.ts`):

| Provider          | Route                                                                                           | Primary source                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code       | Native dispatch: prompt string starting `/name args`                                            | [Agent SDK skills: dispatch commands by name](https://code.claude.com/docs/en/agent-sdk/skills), [headless](https://code.claude.com/docs/en/headless) |
| Codex             | Typed `skill {name, path}` item plus `$name` text                                               | [Codex app-server](https://developers.openai.com/codex/app-server/), generated `v2/UserInput.ts`                                                      |
| OpenCode          | Typed prompt `skills[{id, mention}]`                                                            | [OpenCode skills](https://opencode.ai/docs/skills/), pinned `@opencode/schema` `prompt-input.d.ts`                                                    |
| Pi                | Native `/skill:name args` prompt prefix, expanded by the RPC `prompt` command                   | [Pi RPC commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)                                                   |
| ACP / Antigravity | Advertised command as prompt text                                                               | [ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)                                                                      |
| Cursor            | SKILL.md injection; `@cursor/sdk` 1.0.35 has no typed skill input or documented slash expansion | [Cursor SDK](https://cursor.com/docs/sdk/typescript)                                                                                                  |
| ace skills        | SKILL.md injection on every provider                                                            | ace's own contract                                                                                                                                    |

Injection uses the body the catalog already read through `SecureCommandIo` (containment, depth and 64 KiB file limits), with frontmatter removed. The translated provider input starts with one block per skill: `<skill name="…" path="…/SKILL.md">`, a line naming the skill directory for relative references, then the body, with `$ARGUMENTS` replaced or arguments appended. The chip position becomes `[skill: name]`. Bodies are re-read by the file watchers, so an edited skill sends its current body. A message's injected skills are capped at 256 KiB combined and fail with `catalog_skill_too_large` rather than truncating. A skill whose SKILL.md cannot be found fails with `catalog_skill_unavailable` before provider input exists; deleted or no-longer-user-invocable skills fail as unavailable mentions. Stored parts keep the chip unchanged.

ace's shipped skills (`@ace/plugins` `builtin-skills`) load natively in Claude, Codex, OpenCode and Pi sessions and are advertised there. For Cursor, ACP and Antigravity the daemon also catalogs the shipped directory as ace skills, so selecting one injects its body. ace skills with declared `arguments` keep the prompt-template expansion.

The composer creates a chip when a suggestion is picked with Enter, Tab or a click. A message typed as `/name …` that names an invocable catalog entry exactly is sent with that entry's chip, so it goes through the same routes.

Limits: injection does not apply provider-only skill features such as Claude `allowed-tools`, `context: fork` or `` !`command` `` preprocessing; those apply on the native routes. Claude dispatch from an array of content blocks (a message with images) is not documented; text-only admissions are sent as strings. Cursor plugin skills that ace cannot read from disk receive a named instruction.

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
