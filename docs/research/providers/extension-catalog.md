# Extension discovery and invocation, 2026-10-07

The implementation was written from ace's own contracts, installed public CLI help/generated schemas, pinned SDK declarations and primary provider documentation. No competitor implementations, application bundles, real prompts, recorder sessions or credential files were used. All checked-in definitions in tests are synthetic.

| Provider                         | Preferred metadata                                                                                                               | Local definition fallback                                                                                              | Invocation                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code                      | CLI plugin list --json, SDK initialization, supportedCommands/supportedAgents, commands_changed; init plugins and MCP tool names | `.claude/{skills,commands,agents}` in selected home/project; standard directories of harness-confirmed plugins         | Skill tool name, named delegation, enabled plugin/tool instructions                        |
| Codex 0.159.1 app-server         | skills/list with cwd and forceReload; paginated app/list and mcpServerStatus/list; native updates                                | Selected CODEX_HOME skills/prompts/agents; project `.codex` and `.agents/skills`; default shared user `.agents/skills` | Typed skill `{name,path}`; typed mention `{name,path:"app://id"}`; custom prompt expansion |
| OpenCode @opencode/client 2.0.22 | command.list, skill.list, agent.list, plugin.list, mcp.list; corresponding updated events                                        | Selected config home; project `.opencode`; JSON/JSONC command/agent metadata; shared `.agents/skills`                  | Prompt skill IDs and agent ranges; session.command for commands                            |
| Cursor SDK 1.0.35                | No public extension-list method in SDKAgent                                                                                      | `.cursor/{skills,commands,agents}` in home/project                                                                     | Command expansion and explicit skill/agent instructions; no claim of a typed plugin API    |
| Pi                               | get_commands RPC metadata                                                                                                        | `.pi/agent/{skills,prompts}` globally and `.pi/{skills,prompts}` in project                                            | Native `/skill:name` or extension command prefix; local prompt expansion                   |
| Generic ACP / Antigravity        | available_commands_update session notifications                                                                                  | No arbitrary definition scan for unknown ACP executables                                                               | Native command prefix in session/prompt                                                    |
| ace                              | PluginManager snapshots and provider projection; AutomationService definitions                                                   | Existing ace prompts and skills, global/project                                                                        | Existing client actions and automation.run; provider-loaded components                     |

Claude's current skill documentation specifies personal-over-project precedence, with skills winning over legacy commands. Project overrides global definitions for the other implemented fallback surfaces. Native successful lists take priority over fallback guesses, including disabled/inaccessible entries. Unknown provider frames continue through existing raw diagnostics; the catalog extracts only bounded display and invocation fields.

Sources:

- [Claude skills, precedence and invocation](https://code.claude.com/docs/en/skills)
- [Claude subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude SDK reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [Codex subagents](https://developers.openai.com/codex/subagents/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/) and [skills](https://opencode.ai/docs/skills/); the pinned v2 declaration contracts take precedence over older SDK examples
- [Cursor SDK](https://cursor.com/docs/sdk/typescript), [skills](https://prod.cursor.com/docs/skills) and [plugins](https://prod.cursor.com/docs/reference/plugins)
- [Pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [ACP advertised commands and invocation](https://agentclientprotocol.com/protocol/v1/slash-commands)

## UI handoff

Use the typed client `request({type:"catalog.list",threadId,query,limit,subscribe:true},{requestId})`, or provide an owned `draft` instead of `threadId`. Observe `catalog.changed` through `onMessage`; match its requestId. Reissue subscriptions after reconnect and send `catalog.unsubscribe` on close. Snapshots replace the visible list; stale indicates background discovery. Query matching works independently of composer position.

Rows expose kind, source scope/provider, description and optional icon. An unavailable descriptor means selection must be disabled with its reason. An action descriptor dispatches the existing action (for `automation.run:<id>`, call the existing automation.run service); it must not create a mention chip.

For an invocable row, insert this part between the surrounding text parts:

```json
{ "type": "mention", "entryId": "<row.id>", "name": "<row.name>", "kind": "skill", "arguments": "" }
```

Copy the actual kind and optional icon from the row. No invocation field is needed. For prompt descriptors with `parameters`, collect values into the mention’s optional `values` object using the same argument types as the existing command palette. Keep the chip as a structured part while editing, queuing, sending and rendering stored messages. Send the complete parts array using the existing thread.create/thread.send/context path. Do not resolve to slash text in the composer. The daemon re-resolves entries under the selected thread/account and translates only the provider input. Render stored mention parts using their persisted name/kind/icon even if the current catalog later changes.

The fake daemon has synthetic catalogs for each supported provider, global/project/plugin/ace scopes, native app icons, multiple entry kinds, subscriptions and replacement seeds through `extensionCatalogs`. Catalogs and structured transcript parts are verified through the real client protocol.

Remaining native limits: isolated permission modes may disable ambient extensions; hook-only plugins have no direct invocation; MCP status-only APIs expose servers without inventing tool names; some SDKs omit provenance; custom loaded-plugin layouts need harness metadata. Native model behavior and actual tool execution require an owner-authorized live provider test. These limits do not authorize permission changes or quota spending.
