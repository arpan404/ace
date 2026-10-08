# Pi provider research

Researched 2026-10-02 for the installed Pi **0.85.1**. The supported implementation target is the user's local CLI, with stdio RPC and an explicit ace-owned extension. No prompt was sent, no provider session was started, no authentication command was executed, and no fixture or test was run during this research.

## Evidence and scope

The only local executable calls were `/opt/homebrew/bin/pi --version` and `/opt/homebrew/bin/pi --help`. The binary reports `0.85.1` and resolves to `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`. Its package metadata names `@earendil-works/pi-coding-agent`, version `0.85.1`, MIT, Node `>=22.19.0`, and the official [earendil-works/pi repository](https://github.com/earendil-works/pi).

Installed documentation and compiled package source are the authority for 0.85.1. The versioned upstream links below identify their corresponding source files. `pi.dev/docs/latest` was also inspected, but has already changed since this installed version. In particular, **latest documents built-in MCP while installed 0.85.1 explicitly has no built-in MCP**. Latest documentation must not be used as evidence that this binary accepts `mcp.json` or `registerMcpServer`.

All implementation recommendations below are ace design decisions derived from these APIs. No provider implementation is copied. No t3code or ace-legacy source was consulted.

### Primary source index

Paths beginning `docs/` or `dist/` in this note are relative to the installed package directory above.

| Reference        | Installed evidence                                                                                         | Official versioned counterpart                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI              | `--help`, `--version`, `package.json`                                                                      | [package metadata](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/package.json)                                                                                                                                                                                                                               |
| RPC              | `docs/rpc.md`, `dist/modes/rpc/rpc-types.d.ts`, `dist/modes/rpc/rpc-mode.js`                               | [RPC guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md), [types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/modes/rpc/rpc-types.ts), [mode](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/modes/rpc/rpc-mode.ts)               |
| JSON             | `docs/json.md`, `dist/modes/json-event.js`                                                                 | [JSON mode](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/json.md), [event conversion](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/modes/json-event.ts)                                                                                                                 |
| Sessions         | `docs/sessions.md`, `docs/session-format.md`, `dist/core/agent-session.js`, `dist/core/agent-session.d.ts` | [sessions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sessions.md), [format](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/session-format.md), [AgentSession](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts)      |
| SDK              | `docs/sdk.md`, `dist/index.d.ts`                                                                           | [SDK guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md)                                                                                                                                                                                                                                       |
| Extensions       | `docs/extensions.md`, `dist/core/extensions/loader.js`                                                     | [extension guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md), [loader](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/loader.ts)                                                                                                         |
| Skills           | `docs/skills.md`                                                                                           | [skills guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/skills.md)                                                                                                                                                                                                                                 |
| Permissions      | `docs/security.md`, `README.md`                                                                            | [security](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/security.md), [README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/README.md)                                                                                                                                      |
| Authentication   | `docs/providers.md`, `dist/cli/auth-command.js`, `dist/cli/auth-check.js`                                  | [providers](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/providers.md), [auth commands](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/cli/auth-command.ts), [auth checks](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/cli/auth-check.ts) |
| Versions         | `CHANGELOG.md`                                                                                             | [0.85.1 changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/CHANGELOG.md)                                                                                                                                                                                                                               |
| Current web docs | inspected 2026-10-02, not version-pinned                                                                   | [RPC](https://pi.dev/docs/latest/rpc), [extension UI](https://pi.dev/docs/latest/rpc-extension-ui), [MCP](https://pi.dev/docs/latest/mcp), [security](https://pi.dev/docs/latest/security)                                                                                                                                             |

## Integration choices

| API              | 0.85.1 behavior                                                                                                                                                                                                                                                                        | ace recommendation                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pi --mode rpc`  | Persistent headless process. JSON commands on stdin, command responses and asynchronous events on stdout. Extension UI has a separate request/response protocol.                                                                                                                       | Use this through provider-kit. Pi keeps its own local login and session storage.                                           |
| `pi --mode json` | Emits the session header first, then JSON events. Streaming updates contain deltas without cumulative snapshots. It is an output stream rather than the RPC command interface.                                                                                                         | Useful for approved future recordings, not the interactive ace adapter.                                                    |
| TypeScript SDK   | Main package exports `createAgentSession`, `AgentSession`, `SessionManager`, `ModelRuntime`, and `createAgentSessionRuntime`. Session replacement belongs to `AgentSessionRuntime`; tree navigation belongs to `AgentSession`.                                                         | Documented alternative. Do not silently replace the installed CLI with an ace-installed SDK or different credential store. |
| ACP              | Installed help has only `text`, `json`, and `rpc`. Installed RPC types and package exports contain no Agent Client Protocol endpoint. Upstream [ACP request #175](https://github.com/earendil-works/pi/issues/175) is an enhancement request, not evidence of an installed ACP server. | Advertise no native ACP. Do not depend on independently maintained `pi-acp` adapters.                                      |

The installed 0.85.1 changelog says the experimental `client` and `experimental/plugin` subpaths and server/client commands are source-only after a packaging failure in 0.85.0. They are not a supported integration route for an ordinary installed binary. See the versioned changelog and SDK guide.

### Framing and request completion

RPC is JSONL with LF as the only delimiter. Strip a trailing CR for CRLF; retain Unicode U+2028 and U+2029 inside JSON strings. Pi's own guide explicitly rejects a generic line reader that splits those Unicode characters. Every command can carry an `id`. Responses have `type: "response"`, `command`, `success`, the matching `id`, and optional `data` or `error`. Events usually have no request id. Native stdin command processing can overlap, so ace must correlate by id rather than response order. See RPC guide and mode source.

Unlike JSON mode, RPC does not emit a startup session header. Query `get_state` and retain both `sessionId` and `sessionFile`. A `prompt` success response means accepted, queued, or handled by an extension. It is not completion. Errors after acceptance arrive in subsequent session events or messages. Native `steer` and `follow_up` responses also acknowledge queueing, not execution. See RPC guide and mode source.

For ace, bound each record, pending RPC requests, active tool calls, content blocks, dialogs, and outbound writes. Reject an oversized record or capacity overflow explicitly. Do not keep a cumulative transcript in the translator. Parse only fields needed for facts and preserve the original unknown fields/event as raw data. These are ace decisions required by ADR 0007 and the repository performance rules.

### Status and streaming

`turn_end` completes one assistant response plus its tools. `agent_end` completes a low-level run and includes `willRetry`; it can precede retry, compaction, or queued continuations. Only `agent_settled` means Pi has no automatic retry, compaction retry, or queued continuation left. Therefore ace must never report done from `turn_end`, `agent_end`, or a successful `prompt` response. See RPC events and `AgentSessionEvent` definitions.

Keep the ace run open across native turns until `agent_settled`. Tool start/end facts and open extension interactions still participate in ace's whole-tree status, even when an unexpected settled event arrives. A process exit supplies process facts, not a fabricated successful completion. This follows ace ADR 0004 and is stricter than treating native settled as a whole-tree result.

`message_update.assistantMessageEvent` contains `contentIndex` and constant-sized delta events. Text and thinking use `text_delta` and `thinking_delta`; tool-call start supplies `id` and `toolName`, and tool-call end supplies the complete tool call. `message_end` contains the authoritative final message, whose `stopReason` can be `stop`, `length`, `toolUse`, `error`, or `aborted`. Usage accompanies updates and final assistant messages. Tool execution frames use `toolCallId` and `toolName`; updates contain `partialResult`, and end contains `result` and `isError`. See JSON guide, RPC events, and session-format guide.

`queue_update` contains the full pending `steering` and `followUp` arrays. Compaction, automatic retry, and summarization retry have explicit events. The installed type definitions also expose `entry_appended`, `session_info_changed`, and `thinking_level_changed`, which the older RPC events table does not list. `entry_appended.entry.id` is a durable native cursor and can identify rollback/fork targets without polling history. Preserve it as native data. See `AgentSessionEvent` and RPC mode's session subscription.

## Sessions, resume, fork, rollback, and steering

Pi stores sessions under `~/.pi/agent/sessions/`, organized by cwd, unless `--session-dir` or `PI_CODING_AGENT_SESSION_DIR` overrides storage. Files are JSONL trees. Entries have stable `id`/`parentId`; the current position is a leaf. Version 3 is current; legacy versions 1 and 2 migrate on load. Native sessions preserve compactions, labels, model changes, custom entries, and abandoned branches. See sessions and session-format guides.

| Operation              | Native API                                                       | Semantics and ace handling                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resume                 | CLI `--session <path-or-id>`; RPC `switch_session {sessionPath}` | Explicit paths avoid partial-UUID ambiguity. Query `get_state` after startup or switch. Honor extension cancellation. `--session-id` may create a missing session, so it cannot stand in for verified resume. |
| Continue               | CLI `--continue`                                                 | Selects the most recent session. ace uses an explicit saved identity.                                                                                                                                         |
| Fork earlier prompt    | RPC `fork {entryId}`                                             | Creates a new file before a selected user message and returns its original text without resubmitting it. Honors `session_before_fork` cancellation. Query the new identity.                                   |
| Clone current state    | RPC `clone`                                                      | Creates a new file including the active leaf. Empty sessions fail. Honors fork cancellation. Query the new identity.                                                                                          |
| Fork at launch         | CLI `--fork <path-or-id>`                                        | Forks an existing session to a new file in a separate process.                                                                                                                                                |
| Inspect targets        | RPC `get_fork_messages`; `get_entries {since?}`; `get_tree`      | Entries include append order, abandoned branches and `leafId`. The exclusive cursor is scanned with no pagination. Bound control responses; prefer live `entry_appended`.                                     |
| Roll back conversation | Extension `navigateTree(entryId, {summarize:false})`             | No direct RPC command. An ace-owned extension command changes the leaf in the same file. See below.                                                                                                           |
| Steer                  | RPC `steer`, or `prompt.streamingBehavior:"steer"`               | Delivery follows current tool execution before the next LLM call. Does not abort running tools.                                                                                                               |
| Follow up              | RPC `follow_up`, or `prompt.streamingBehavior:"followUp"`        | Waits for tools and steering. Queue updates expose remaining work. ace owns ordinary queued delivery.                                                                                                         |
| Interrupt              | RPC `clear_queue`, then `abort`                                  | Clear queues first to prevent queued continuation. Direct RPC bash has separate `abort_bash`. No individual arbitrary-extension task cancellation exists.                                                     |

These APIs come from the installed RPC, sessions, SDK and extension guides and their matching mode/session source.

### Rollback is conversation navigation

An ace-owned explicit extension can register a control command, await `ctx.waitForIdle()`, and call `ctx.navigateTree(targetId, {summarize:false})`. Registered extension commands execute immediately through `prompt` instead of invoking the model. Return or emit an explicit success/cancellation acknowledgement; ordinary prompt acceptance alone does not establish that navigation happened. Do not implement this by truncating or rewriting native JSONL files. See extension commands and command-context APIs.

Selecting a user or custom entry moves the leaf to its parent and returns its text for an editor. Selecting an assistant, tool, or other entry moves the leaf to that entry. Selecting the root user entry empties active conversation context while retaining the abandoned branch. ace should specify whether a target means before a prompt or after a completed assistant response. `summarize:false` prevents Pi's default summary generation from spending model quota, but trusted extension hooks still run and can cancel navigation. See `AgentSession.navigateTree` and sessions guide.

Installed `SessionManager` reconstructs its active leaf from the latest appended entry when loading. `navigateTree` without a summary changes that leaf only in memory. After successful navigation, the public extension API `pi.appendEntry(customType, data)` appends a custom entry on the current leaf through Pi's persistence owner. Custom entries are excluded from LLM context. A marker preserves the selected branch on source reopen, including a root marker with null parent. Native clone persistence has an additional restriction described below. Require an already persisted session and acknowledge only after the append succeeds. See installed `SessionManager._buildIndex`, `appendCustomEntry`, `_persist`, the extension API's `appendEntry`, and [session format](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/session-format.md).

Pi 0.85.1 `SessionManager.createBranchedSession` writes the new file immediately only when the selected raw branch contains an assistant message. Otherwise its new pathname exists only in memory until a later assistant response. `AgentSessionRuntime.fork` before the first user likewise replaces the runtime with an unflushed new session. Appending a custom marker to that new branch cannot force a flush. ace must reject no-assistant forks before replacing the source, rather than return an unresumable reference or send inference to manufacture persistence. Its bounded `get_entries` preflight follows the selected parent chain, including the before-user semantics of RPC `fork`. If a supposedly durable fork still fails validation, restore the source before returning the failure. See [versioned session persistence](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/session-manager.ts) and [versioned runtime fork](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session-runtime.ts), also reread in the installed 0.85.1 source during the 2026-10-03 verifier follow-up. Root rollback and source reopen remain supported; root clone is refused with the source intact.

Native v1 message entries have no tree IDs or parents. Pi migrates them to a chained tree and rewrites the file on load. Preserve conversation continuity while allowing this provider-owned migration, rather than asserting byte-identical legacy files. See the same versioned SessionManager's documented migration functions. These sources were read for interface and persistence semantics; ace's admission and synthetic peer implementation are written independently. A checkout cannot prove historical source-access claims.

An explicit session pathname can refer to a missing file while Pi initializes a fresh empty session under that same pathname. Validate an existing bounded session header and compare its ID with `get_state.sessionId`. An ace reference that also retains the expected native ID detects a replacement file before startup. Native v1 headers omit `version`; treat its absence as v1. See installed `SessionManager.setSessionFile`, `_loadEntries`, and the session-format guide.

This does **not** restore workspace files. Advertise conversation rollback separately from `rewindFiles`, which remains false. ace git checkpoints own file restoration. Fork and rollback also must not claim to stop detached work that arbitrary user extensions created.

## Skills, extensions, and dialogs

Pi discovers global skills from `~/.pi/agent/skills` and `~/.agents/skills`, trusted project skills from `.pi/skills` and ancestor `.agents/skills`, and configured/package/explicit `--skill` locations. Skill names/descriptions enter the prompt, while the agent loads full instructions on demand. `/skill:name` expands a selected skill. `--no-skills` disables discovery but explicit `--skill` paths still load. Installed help's short description is less precise than the full skills guide. See skills guide.

Extensions are TypeScript modules loaded in Pi's process through its extension loader. They can register tools, commands, providers, lifecycle hooks, and UI. Auto-discovery includes global extensions and trusted project extensions; explicit `-e <path>` still loads with `--no-extensions`. The loader provides Pi package aliases and TypeBox to extensions, including bundled executable installations. ace can provide one stable extension file through `-e` without copying it into the user's config or importing provider internals into the daemon. See CLI help, extension guide, and loader source.

`registerTool` accepts a name, description, parameter schema, and async execution callback with an AbortSignal. Tools can register during load or later. `tool_call` hooks can return `{block:true, reason}` before execution. These hooks are extension policies, not native permission modes. Extensions execute arbitrary code with the Pi process's OS privileges. See extension guide.

RPC supports these dialog requests, each with a unique native id:

| `extension_ui_request.method` | Fields                                     | Matching `extension_ui_response`                                |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `select`                      | `title`, `options`, optional `timeout`     | `id`, `value` equal to one supplied option; or `cancelled:true` |
| `confirm`                     | `title`, `message`, optional `timeout`     | `id`, `confirmed:true/false`; or `cancelled:true`               |
| `input`                       | `title`, `placeholder`, optional `timeout` | `id`, `value` text; or `cancelled:true`                         |
| `editor`                      | `title`, `prefill`                         | `id`, `value` multiline text; or `cancelled:true`               |

Project these as pending ace interactions with the native id retained. A generic confirm dialog is a yes/no question, not proof of a privileged tool approval. Only an ace-owned permission extension with a known request shape can classify its confirm as approval. Validate resolutions by method and option membership; send cancellation for reject/dismiss as appropriate. `extension_ui_response` receives no ordinary command response. See RPC extension UI and mode source.

`notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text` are fire-and-forget UI requests. They must not open blocking interactions or send responses. Preserve unsupported UI requests as raw notices. `custom()` and terminal-specific UI are unavailable or degraded in RPC. `ctx.mode` is `rpc` and `ctx.hasUI` is true. See RPC extension UI.

Pi resolves select/input timeout to undefined and confirm timeout to false. The installed RPC implementation emits no timeout-close frame. Its `ui_prompt_start`/`ui_prompt_end` are extension hooks, not automatically forwarded session events. ace must retire matching timed interactions through an injected deadline or an ace-owned extension close notification, and retire them on process exit. `editor` has no timeout field in this version. A settled event alone must not silently resolve an unrelated pending interaction. See mode source and extension UI lifecycle hooks.

## Permissions Pi enforces

Pi 0.85.1 has no built-in per-tool permission popups, sandbox, or plan mode. Its native default gives built-in tools the process user's OS rights. Native tool selection does exist: `--tools` is an allowlist applying to built-in, extension, and custom tools; `--exclude-tools` is a denylist; `--no-tools` disables all tools by default; `--no-builtin-tools` retains extension tools. `--tools read,grep,find,ls` is Pi's documented read-only example. This limits available model tools, not arbitrary extension code or the process environment. See CLI help, README's design choices, and security guide.

Project trust is separate. `--approve` permits project resources for one run; `--no-approve` skips them. Saved decisions live in Pi's `trust.json`; the default `ask` in RPC/JSON mode silently skips protected project resources without a saved decision. Global and explicit CLI extensions still load, and context files still load unless disabled. Never equate `--approve` with approving all tool calls. See security guide.

Recommended ace mapping, to be made explicit in the ADR:

| ace policy                                   | Truthful Pi mapping                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unrestricted tool execution                  | Pi's default native execution, with project trust chosen separately.                                                                                                         |
| Read-only model tools                        | Native allowlist `read,grep,find,ls`, with any permitted ace read tools named explicitly. No bash, edit, write, or unknown extension tool. No OS sandbox claim.              |
| Ask before selected/all actions              | Requires the ace-owned extension's pre-execution `tool_call` gate and RPC dialog forwarding. Do not advertise it as native Pi policy. Fail closed when the gate cannot load. |
| Approve edits but ask for shell/custom tools | Requires the same ace-owned gate, with a defined allowlist. Pi has no equivalent native named mode.                                                                          |
| Plan mode or workspace sandbox               | Unsupported natively. ace must gate controls or supply a separate authorized implementation.                                                                                 |

Keep permission support honest even if another provider has more named modes. An extension gate cannot constrain arbitrary other extension code. MCP authorization remains daemon-enforced per ADR 0010, independently of the Pi gate.

## Subagents and whole-tree visibility

Installed README states that Pi has no built-in subagents; extensions can spawn Pi processes or implement custom orchestration. The official extension examples include `subagent/`, but arbitrary packages do not share a guaranteed child lifecycle/transcript protocol. A tool named `subagent` or `task` alone is insufficient to invent child agents, completion, or cancellation. Advertise `subagentTranscripts:false`, `backgroundVisibility:"none"`, `backgroundTaskControl:false`, and no guaranteed native interrupt cascade. See README and extension examples index.

ace-owned `ace_spawn_agent` calls can still create canonical children through the existing MCP/orchestrator contracts. Their whole-tree state belongs to ace. Pi's `agent_settled` closes only its own run and cannot close ace children. Unknown extension subagent progress is retained as native tool/raw information until a separately documented integration provides stronger facts.

## Injecting ace MCP tools into 0.85.1

There is no native MCP configuration or `registerMcpServer` in installed 0.85.1. Its README recommends building an extension for MCP. Use an explicit ace-owned extension and the daemon's existing loopback MCP server and scoped session lease. Do not install an unreviewed third-party MCP package, mutate the user's settings, or write bearer secrets into project files. See 0.85.1 README and extension guide; ace ADR 0010 defines lease ownership.

The extension can expose ace tool names through `registerTool` and forward executions to the existing authenticated daemon MCP endpoint, either through the accepted official MCP client or a thin ace-owned local bridge using the shared MCP contracts. Keep discovery, arguments, replies, and pending calls bounded; honor Pi's execution AbortSignal; preserve MCP text/image/structured errors; and never auto-retry a call that could already have performed a side effect. The extension must not let model input choose its caller thread/agent or override the scoped URL/headers. Revoke the lease at session close/exit. These are ace design requirements, not additional Pi protocol claims.

Pass scoped ace endpoint/token through process environment only. The extension reads them locally. Return safe tool results without bearer headers or lease secrets in raw frames. An explicit read-only Pi allowlist must include the intended ace tool names, or Pi will hide them. MCP tools that mutate state must remain disabled in a read-only policy. Extension `session_shutdown` and Pi process lifetime must end outstanding forwarding operations.

The inspected [latest MCP docs](https://pi.dev/docs/latest/mcp) now support stdio and streamable HTTP, `mcp.json`, header environment expansion, and extension `registerMcpServer`. This is a future version-gated route. Do not claim an introduction version from a mutable latest page, and do not activate this route until its exact installed API has been researched and verified.

## Authentication and local login

Use the user's existing Pi login. Interactive Pi owns `/login` and `/logout`; its `~/.pi/agent/auth.json` stores API-key or OAuth entries and Pi refreshes OAuth. `PI_CODING_AGENT_DIR` selects a different Pi configuration directory, so account isolation must preserve the user's selected instance directory consistently. Credentials resolve from explicit CLI override, stored Pi auth, environment, and custom model configuration. ace should never pass `--api-key`, read credential contents, or surface them in event logs. See providers guide and CLI help.

The installed CLI has a safe readiness command shape `pi auth check --provider <name> --json --no-refresh`. Its parser also supports `--model`; its safe response reports `status` as `ready`, `not_ready`, or `invalid`, provider, optional auth type/reason. Omitting `--no-refresh` can refresh OAuth credentials; adding `--credentials` returns credential material. `print-api-key` and `print-bearer-token` explicitly print secrets. Never invoke either printer or `--credentials` through discovery. No auth command was executed for this research. See auth command/check sources.

The readiness implementation disables model-network refresh on creation, but credentials can have custom resolution behavior. Discovery should expose only safe status fields and preserve errors as unavailable, without reading or printing credential data. User extensions are not loaded by this stock auth-check path, so a custom extension provider can be absent even though an eventual session can use it. Use the embedded native Pi terminal and `/login` for custom services. Do not synthesize hosted login or proxy provider credentials.

Pi documents several subscription and API-key providers. That catalog is not ace's authorization to host their authentication or requests. The adapter uses installed Pi locally under ADR 0002; it does not become a provider gateway.

## Version gating and capability claims

Set the initial audited baseline to **0.85.1**, rather than accepting an arbitrary older Pi with different status or extension behavior. The installed changelog identifies `agent_settled` and fully settled idle waiting as additions in **0.80.4**, and `get_entries`/`get_tree` as additions in **0.80.3**. These are useful historical boundaries, not evidence that every intermediate version supports the complete ace integration. The 0.85.1 packaging fix also matters for SDK imports.

Discovery should use provider-kit to resolve `pi`, parse a bounded version response, and report unsupported/unknown versions clearly. Do not send a prompt to determine capability. Keep native facts separate from ace extension negotiation; rollback and gated permissions require the known extension contract even on a recognized CLI version. Native resume/fork/steering can advertise support for the audited baseline; `rewindFiles`, native plan mode, native subagents, and generic background-task control remain false.

Newer minor versions may keep basic RPC but must not silently gain native MCP or other optional features from a version comparison alone. Require a versioned research update and capability evidence before exposing changed commands. Unknown frames and additive fields remain raw and nonfatal, so a future event does not destroy an otherwise valid stream. If `agent_settled` disappears, fail visibly rather than falling back to early `agent_end` completion.

Synthetic tests should use documented frames, including multiple native turns, `agent_end` followed by retry, compaction retries, queue updates, overlapping dialogs, Unicode separators, cancellations, unknown fields, and process exits. They are not recorded fixtures. Actual recorder scenarios require the owner's separate approval and remain unrecorded. Tests, mutations, and benchmarks need execution at merge under the owner's current rule.

## Sign-in update (2026-10-08)

One read-only probe from a fresh scratch directory ran the owner's selected
`pi --version` and `pi --help`. It reports **1.1.0**. No real login, model prompt,
SDK import, recorder or credential read was performed. Installed SDK declarations,
provider docs and non-bundle auth source confirm the same interaction contract in
0.85.1 and 1.1.0:

- No standalone CLI login subcommand and no RPC login operation is documented.
- `ModelRuntime.create({refreshOnCreate:false})` avoids model/auth refresh on
  creation. `login(provider,"oauth",interaction)` owns persistence and returns
  credentials; ace's isolated child discards the return value. Native `logout`
  owns deletion.
- OpenAI Codex selects `device_code`, then emits a verification URI and user code.
- Anthropic selects `browser`, emits an authorization URL and waits for a local
  callback. Its optional `manual_code` fallback is raced against that callback;
  ace leaves it pending and honours the SDK's abort signal. Browser sign-in on a
  different machine and manual authorization-code forwarding are not implemented.
- GitHub Copilot asks for an optional enterprise host before its device challenge.
  ace chooses the blank GitHub.com value. Enterprise login remains available in
  the native terminal under Other provider.
- Pi's changelog removed Gemini CLI and Antigravity integrations in **0.71.0**.
  These are absent from both reviewed releases' built-in OAuth providers.

Primary references: [SDK provider management](https://pi.dev/docs/latest/sdk/providers),
[0.85.1 ModelRuntime](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/model-runtime.ts),
[1.1.0 ModelRuntime](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/model-runtime.ts),
[Anthropic OAuth](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/anthropic.ts),
[OpenAI OAuth](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/openai-codex.ts),
[Copilot OAuth](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/github-copilot.ts),
[changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md).
The installed package's public declarations and auth source are authoritative if
upstream tags are unavailable or latest docs move.

Read-only owner checks also inventoried directory entries under `.claude` (33),
`.codex` (76), OpenCode config (9), OpenCode data (11) and ace logs (1). No
credential or transcript contents were read or copied. The safe appearance projection
of `~/.ace-next/settings.json` contains no theme/accent override. Appearance lives
in each client's local storage, which was not inspected. Fake screenshots therefore
exercise amber in all seven presets, light/dark at 1440 and 390 pixels. Synthetic
fixtures cover a first-login profile without settings, a configured default that
is signed out while another service is ready, and an unknown release. Real OAuth,
subscription entitlement and the exact owner-local appearance remain unverified.
