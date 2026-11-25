# The Claude session in Rust (E3-claude)

The owner started this work on 2026-11-25 (ADR 0223, "Decided by the orchestrator, pending the
owner"). It replaces `@anthropic-ai/claude-agent-sdk` inside the daemon with a Rust session that
speaks the `claude` CLI's stream-json protocol itself (`-p --input-format stream-json
--output-format stream-json`). The session is spawned through the E2 supervisor, sits behind
`ProviderSession` like the other E3 sessions, and has its own switch (`ACE_SESSIONS=claude`).
The builder items are E3-claude.1 to .6 in the [porting guide](porting-guide.md#e3-claude-claude-stream-json-over-stdio-one-cli-process-per-session).
This file holds what those items share: where each wire message comes from, the frame contract,
the crate's public API, the hot path, the scope decisions and the open questions.

## Clean room

The Agent SDK is proprietary. Its implementation (`sdk.mjs`, `core-*.mjs`, `cli.js` and any other
`.js`/`.mjs` under `node_modules/@anthropic-ai`) is never opened, by planners or builders. Its
`.d.ts` files may be read, but only to learn which interfaces and message types exist (names and
field names, never behaviour). Everything here comes from these sources:

| Tag      | Source                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[cli]`  | [CLI reference](https://code.claude.com/docs/en/cli-reference), the flags table                                                                                                                                                                                                                                                                                                                                                                |
| `[hl]`   | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless): `-p`, stream-json output, SIGTERM and close behaviour                                                                                                                                                                                                                                                                                                            |
| `[ov]`   | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): "To drive the same agent loop from a language other than Python or TypeScript, run the CLI as a subprocess"                                                                                                                                                                                                                                                          |
| `[ts]`   | [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript): `Query` methods, `SDKControlInitializeResponse`, `SDKControlInterruptResponse` (including `cancel_queued` for "a client that drives the CLI's control protocol directly"), `CanUseTool` (its `requestId` is "the `control_request` envelope's `request_id`"), `PermissionResult`, `SDKUserMessage` and `priority`, `pending_permission_requests`, hook types |
| `[d.ts]` | `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.288, type names only: `SDKControlRequest` (`{type, request_id, request}`), `SDKControl*Request` subtypes and fields, `ControlResponse`/`ControlErrorResponse`, `SDKHookCallbackRequest`, `SDKHookCallbackMatcher` ("opaque ids chosen by the client"), `CanUseTool`, `ElicitationRequest`, `UserDialogRequest`                                                                              |
| `[fx]`   | ace's recordings `fixtures/claude/2.1.286/*.jsonl` (CLI 2.1.286): `native-ace-mcp.jsonl` seq 2 (the `initialize` request as sent) and seq 3 (its response)                                                                                                                                                                                                                                                                                     |
| `[fake]` | ace's fake CLI `packages/adapter-claude/src/testing/cli.ts`, the inline fakes of `metadata-host.process.test.ts` and `cmd-shim-metadata.process.test.ts`, and `tools/daemon-bench/src/fake-cli/claude.ts`                                                                                                                                                                                                                                      |
| `[test]` | an ace test that pins the shape (the fake echoes every control request as `system/fake_control` with `argv`, and every user message as `system/fake_input`)                                                                                                                                                                                                                                                                                    |

`[d.ts]` names a field; it never settles behaviour. Behaviour comes from `[cli]`, `[hl]`, `[ts]`,
`[fx]` or `[test]`. Where none of those settles a point, it is an open question (the last section);
nobody guesses it, and nobody settles it by running the SDK and watching what it does.

ace drives the person's own unmodified `claude`, signed in through Anthropic's own flow, and
never reads, stores or passes on a credential (ADR 0002). The Rust session spawns the CLI with
the environment the TypeScript session gives it today (`session.ts:59`, `:241`) and nothing more.

## 1. Inventory: every SDK use, what it puts on the wire, and its source

### 1a. Imports

| Import                                                      | Where                                                                                | Kind  | Fate                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------- |
| `query` (dynamic)                                           | `session.ts:146`                                                                     | value | replaced by the Rust session (E3-claude.1–.4)                             |
| `Query`, `SDKUserMessage`                                   | `session.ts:17`                                                                      | type  | not imported by the native facade                                         |
| `SpawnedProcess`, `SpawnOptions`                            | `sdk-process.ts:7`                                                                   | type  | `sdk-process.ts` stays for the metadata host; the native session skips it |
| `Options`                                                   | `configuration.ts:3`                                                                 | type  | `configurationOptions` stays; the facade maps its result to `Launch`      |
| `PermissionResult`, `PermissionUpdate`, `SDKUserMessage`    | `input.ts:5`–`:9`                                                                    | type  | `permissionResult` and `admissions` stay TypeScript, called by the facade |
| `PermissionResult`, `PermissionUpdate`, `ElicitationResult` | `pending-interactions.ts:3`–`:7`                                                     | type  | its state moves to Rust; its validation stays in the facade (E3-claude.3) |
| `Query`, `McpServerConfig`                                  | `mcp-controls.ts:2`                                                                  | type  | `nativeMcpServers` stays; the controls become control requests            |
| `Query`                                                     | `metadata-questions.ts:1`, `metadata-query.ts:1`                                     | type  | out of scope (section 5)                                                  |
| `query` (dynamic)                                           | `metadata-query.ts:47`                                                               | value | out of scope: runs in the metadata host child (section 5)                 |
| `forkSession` (dynamic)                                     | `fork-worker.ts:8`                                                                   | value | out of scope: runs in the fork worker child (section 5)                   |
| `query`, `CanUseTool`, `SDKUserMessage`                     | `tools/recorder/src/providers/claude.ts:1`                                           | value | not daemon code; unchanged, and never run for this work                   |
| package name                                                | `apps/daemon/bench/idle-import-hook.ts:22`, `tools/release/src/runtime-assets.ts:12` | list  | unchanged while the metadata host and fork worker ship the SDK            |

### 1b. `query()` options (`session.ts:148`–`:280`) and what each becomes

The SDK turned options into `argv` and into fields of the first control request. The Rust
`Launch` and `Initialize` (section 3) do it from now on. A "pinned" cell names the test that fails
if the form is wrong.

| Option (TS line)                                                           | On the wire                                                                                                                                                                                                                                                                                                                                                                    | Source, pinned by                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the transport itself                                                       | `claude -p --input-format stream-json --output-format stream-json --verbose`                                                                                                                                                                                                                                                                                                   | `[ov]`, `[hl]` "Stream responses", `[cli]` `--input-format` example. Other required flags: **Q2**                                                                                              |
| `pathToClaudeCodeExecutable` (`:185`), `cwd` (`:172`), `env` (`:241`)      | the command, the child's cwd and environment (`sdk-process.ts:47`–`:52`)                                                                                                                                                                                                                                                                                                       | ace's own spawn today; environment additions by the SDK: **Q3**                                                                                                                                |
| `systemPrompt: preset claude_code, append` (`:150`–`:160`)                 | `initialize.appendSystemPrompt`                                                                                                                                                                                                                                                                                                                                                | `[fx]` native-ace-mcp seq 2; `[d.ts]`                                                                                                                                                          |
| `systemPrompt: preset` alone (`configuration.ts:29`)                       | nothing beyond the default                                                                                                                                                                                                                                                                                                                                                     | `[ts]` Options: the preset is Claude Code's own prompt; **Q4** for the isolated case (no `systemPrompt`)                                                                                       |
| `settingSources` (`configuration.ts:30`, `:34`)                            | `--setting-sources user,project,local`                                                                                                                                                                                                                                                                                                                                         | `[cli]`; `[test]` `sdk-controls.process.test.ts:135`–`:150` reads `[fake]` `cli.ts:95`. The empty list: **Q4**                                                                                 |
| `strictMcpConfig` (`configuration.ts:36`)                                  | `--strict-mcp-config`                                                                                                                                                                                                                                                                                                                                                          | `[cli]`; `[test]` `sdk-controls.process.test.ts:135`–`:150`, `native-tools.process.test.ts:27`                                                                                                 |
| `permissionMode` (`:186`–`:191`)                                           | `--permission-mode <mode>`                                                                                                                                                                                                                                                                                                                                                     | `[cli]`; `[test]` `permissions.process.test.ts:5`–`:22` (via `[fake]` `cli.ts:94`)                                                                                                             |
| `allowDangerouslySkipPermissions` (`:189`)                                 | `--allow-dangerously-skip-permissions`                                                                                                                                                                                                                                                                                                                                         | `[cli]`; not pinned                                                                                                                                                                            |
| `plugins` (`:161`–`:168`)                                                  | `--plugin-dir <path>`, once per directory                                                                                                                                                                                                                                                                                                                                      | `[cli]`; `[fake]` `cli.ts:19`–`:27`; `[test]` `apps/daemon/src/claude-shared-skills.process.test.ts`                                                                                           |
| `extraArgs` chrome (`:169`–`:171`)                                         | `--chrome` or `--no-chrome`                                                                                                                                                                                                                                                                                                                                                    | `[cli]`; `[test]` `session.process.test.ts:262`–`:283`                                                                                                                                         |
| `model` (`:173`)                                                           | `--model <model>`                                                                                                                                                                                                                                                                                                                                                              | `[cli]`; not pinned                                                                                                                                                                            |
| `sessionId` (`:179`, `:183`)                                               | `--session-id <uuid>`                                                                                                                                                                                                                                                                                                                                                          | `[cli]`; `[fake]` `cli.ts:16`; `[test]` every `fake_input` `session_id` check                                                                                                                  |
| `resume` (`:182`)                                                          | `--resume=<uuid>`                                                                                                                                                                                                                                                                                                                                                              | `[cli]`; `[test]` `session.process.test.ts:255`–`:256`, `cmd-shim-session.process.test.ts:177`–`:178` (the `=` form)                                                                           |
| `resume` + `forkSession` + `resumeSessionAt` + `sessionId` (`:174`–`:181`) | `--resume=<source> --fork-session --resume-session-at=<uuid> --session-id <new>`                                                                                                                                                                                                                                                                                               | `[cli]` (`--fork-session`); `--resume-session-at` is not in `[cli]`, but `[test]` `fork-selection.process.test.ts:19`–`:25` and `cmd-shim-session.process.test.ts:189`–`:196` pin it           |
| `effort` (`:184`)                                                          | `--effort <level>`                                                                                                                                                                                                                                                                                                                                                             | `[cli]`; not pinned                                                                                                                                                                            |
| `mcpServers` (`:192`, `mcp-controls.ts:24`)                                | `--mcp-config <json>` with `{"mcpServers":{…}}`, which ace swaps for a private file (`sdk-process.ts:31`–`:34`)                                                                                                                                                                                                                                                                | `[cli]`; `[fake]` `cli.ts:57`–`:66`; `[test]` `sdk-controls.process.test.ts:63`                                                                                                                |
| `includePartialMessages` (`:193`)                                          | `--include-partial-messages`                                                                                                                                                                                                                                                                                                                                                   | `[cli]`, `[hl]`; `[fake]` `cli.ts:485`; `[test]` `session.process.test.ts` "SDK options deliver partial root text"                                                                             |
| `forwardSubagentText` (`:194`)                                             | `initialize.forwardSubagentText: true`                                                                                                                                                                                                                                                                                                                                         | `[fx]` seq 2; `[fake]` `cli.ts:81`; `[test]` same test                                                                                                                                         |
| `perTaskStopAffordance` (`:195`)                                           | `initialize.perTaskStopAffordance: true`                                                                                                                                                                                                                                                                                                                                       | `[fx]` seq 2; `[d.ts]`                                                                                                                                                                         |
| `includeHookEvents` (`:196`)                                               | `--include-hook-events`                                                                                                                                                                                                                                                                                                                                                        | `[cli]`; not pinned                                                                                                                                                                            |
| `hooks` (`:197`–`:240`)                                                    | `initialize.hooks: {<Event>: [{hookCallbackIds: [<id>]}]}`; the CLI asks `control_request {subtype: "hook_callback", callback_id, input, tool_use_id?}`; ace answers `control_response` success with the hook output (`{}`, or `{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext}}`)                                                                 | `[fx]` seq 2 (`hook_0`, `hook_1`); `[d.ts]` ids are the client's own; `[fake]` `cli.ts:364`–`:381`; `[ts]` hook types; `[test]` `permissions.process.test.ts:17` (no `PreToolUse`)             |
| `canUseTool` (`:271`)                                                      | the CLI asks `control_request {subtype: "can_use_tool", tool_name, input, tool_use_id, permission_suggestions?, blocked_path?, decision_reason?, title?, display_name?, description?, default_to_no?, suppress_always_allow_rule?, mcp_server?, agent_id?, matched_ask_rule?, …}`; ace answers `control_response {subtype: "success", request_id, response: PermissionResult}` | `[d.ts]` names; `[ts]` `CanUseTool`, `PermissionResult`; `[fake]` `cli.ts:641`–`:690`; `[test]` `sdk-controls.process.test.ts:152`–`:195`. How the CLI learns that ace answers prompts: **Q2** |
| `onElicitation` (`:273`)                                                   | `control_request {subtype: "elicitation", mcp_server_name, message, mode?, url?, elicitation_id?, requested_schema?, title?, display_name?, description?}`; answer `{action, content?}`                                                                                                                                                                                        | `[d.ts]`; `[fake]` `cli.ts:604`–`:640`; `[test]` `sdk-controls.process.test.ts:5`–`:38` (exact answer)                                                                                         |
| `onUserDialog` (`:275`–`:278`)                                             | `control_request {subtype: "request_user_dialog", dialog_kind, payload, tool_use_id?}`; answer `{behavior: "cancelled"}`                                                                                                                                                                                                                                                       | `[d.ts]`; `[fake]` `cli.ts:620`; `[test]` `sdk-controls.process.test.ts:111`–`:124`. **Q6**                                                                                                    |
| cancellation (`:247`–`:253`)                                               | `{type: "control_cancel_request", request_id}` from the CLI                                                                                                                                                                                                                                                                                                                    | `[d.ts]`; `[fake]` `cli.ts:639`, `:691`; `[test]` `sdk-controls.process.test.ts:41`–`:55`                                                                                                      |
| `prompt: InputStream` (`input.ts:13`–`:37`, `session.ts:377`–`:421`)       | one stdin line per message: `{type: "user", uuid, session_id, parent_tool_use_id: null, message: {role: "user", content}, priority, isSynthetic?}`                                                                                                                                                                                                                             | `[ts]` `SDKUserMessage` and `priority`; `[fake]` `cli.ts:246`–`:262`; `[test]` `session.process.test.ts:9`–`:122`. **Q5**                                                                      |

### 1c. `Query` calls and the control requests they become

Every one is `{type: "control_request", request_id, request: {subtype, …}}` on stdin, answered by
`{type: "control_response", response: {subtype: "success", request_id, response?}}` or
`{…, response: {subtype: "error", request_id, error}}` on stdout (`[d.ts]` `SDKControlRequest`,
`ControlResponse`, `ControlErrorResponse`; `[fx]` seq 3; `[fake]` `cli.ts:186`–`:222`).

| Call (TS line)                                                                          | Request                            | Response read                                              | Source, pinned by                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start of `query()`                                                                      | `initialize` (1b's fields)         | `commands`, `agents`, `models`, …                          | `[ts]` `SDKControlInitializeResponse`; `[fx]` seq 2–3; `[test]` `tool-search-listing.process.test.ts:38`                                                |
| `supportedCommands()` (`session.ts:324`)                                                | none: `initialize`'s `commands`    | `name`, `description`, `argumentHint`                      | `[ts]` "Return type of `initializationResult()`"; `[test]` `catalog-input.process.test.ts`                                                              |
| `supportedAgents()` (`:341`)                                                            | none: `initialize`'s `agents`      | `name`, `description`                                      | same                                                                                                                                                    |
| `applyFlagSettings` (`:334`, `:375`)                                                    | `apply_flag_settings {settings}`   | none                                                       | `[d.ts]`; `[test]` `fork-selection.process.test.ts:52`–`:79`                                                                                            |
| `setModel` (`:370`)                                                                     | `set_model {model}`                | none                                                       | `[d.ts]`; `[test]` `fork-selection.process.test.ts:45`–`:50`                                                                                            |
| `setPermissionMode` (`:374`)                                                            | `set_permission_mode {mode}`       | none                                                       | `[d.ts]`; `[test]` `session.process.test.ts:296`–`:301` (absence only)                                                                                  |
| `backgroundTasks()` (`:426`)                                                            | `background_tasks {}`              | `backgrounded` (boolean); error when disabled              | `[d.ts]`; `[ts]` `backgroundTasks()`; `[fake]` `cli.ts:101`–`:154`; `[test]` `steer-backgrounding.process.test.ts:49`–`:53`                             |
| `interrupt()` (`:447`)                                                                  | `interrupt {}`                     | `{still_queued, cancelled?}`, noted as `interrupt_receipt` | `[ts]` `SDKControlInterruptResponse`; `[fake]` `cli.ts:196`, `:234`–`:244`; `[test]` `session.process.test.ts:307`–`:321`                               |
| `stopTask(id)` (`:441`, `:462`, `:477`)                                                 | `stop_task {task_id}`              | none; error text                                           | `[d.ts]`; `[fake]` `cli.ts:156`–`:168`; `[test]` `session.process.test.ts:157`–`:184`, `sdk-controls.process.test.ts:196`–`:209`                        |
| `mcpServerStatus()` (`mcp-controls.ts:63`)                                              | `mcp_status`                       | `mcpServers`                                               | `[d.ts]`; `[fake]` `cli.ts:186`–`:222`; `[test]` `sdk-controls.process.test.ts:66`–`:83`. **Q7**                                                        |
| `setMcpServers` (`mcp-controls.ts:67`)                                                  | `mcp_set_servers {servers}`        | `{added, removed, errors}`, extra keys kept                | `[d.ts]`; `[ts]` `McpSetServersResult`; `[fake]` `cli.ts:184`, `:186`–`:222`; `[test]` same test                                                        |
| `reconnectMcpServer` (`mcp-controls.ts:77`)                                             | `mcp_reconnect {serverName}`       | none                                                       | `[d.ts]`; `[test]` `sdk-controls.process.test.ts:88`–`:96` (exact)                                                                                      |
| `toggleMcpServer` (`mcp-controls.ts:81`, `:85`)                                         | `mcp_toggle {serverName, enabled}` | none                                                       | same                                                                                                                                                    |
| `usage_EXPERIMENTAL…({skipBehaviors: true})` (`usage-read.ts:106` via `session.ts:352`) | `get_usage {skip_behaviors: true}` | the usage reading                                          | `[d.ts]`; `[fake]` `cli.ts:30`–`:33`, `:169`–`:182`; `[test]` `apps/daemon/src/claude-limits.process.test.ts`, `provider-usage.process.test.ts`. **Q8** |
| `close()` (`:114`–`:124`)                                                               | stdin ends, then the stop plan     |                                                            | `[hl]` "the SDK ends Claude Code's input before sending any signal"; `[ts]` `close()`                                                                   |
| `for await (… of q)` (`:283`)                                                           | stdout lines                       |                                                            | `[hl]`; frame contract below. **Q1**                                                                                                                    |

An error response rejects the call with the CLI's `error` string as its message. No test pins the
text beyond `stop_task`'s, which `interrupt` wraps in its own `AggregateError` message
(`session.ts:468`); E3-claude.3 keeps the string verbatim and says so.

## 2. The frame contract

The engine stores and translates frames, and the E1 translator (`ace-adapter-claude/src/translate/`)
reads them by channel (`translate_interactions.rs:234`–`:289`, `consumed_inputs.rs:27`,
`pending_transcripts.rs:76`). The recorded fixtures are frames of this shape, and `replayFixture`
keeps using them. So the native session emits exactly today's frames: same `dir`, `channel` and
`data`, in the order below. Only the timing of `t` changes (stamped at delivery, E3.0c).

| What happened                                                                                                                                                                                         | `dir`    | `channel`               | `data`                                                                                                                                                            | Today                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| stdout line whose `type` is one of `system`, `assistant`, `user`, `result`, `stream_event`, `rate_limit_event`, `keep_alive`, `tool_progress`, `tool_use_summary`, `auth_status`, `prompt_suggestion` | `recv`   | `sdk`                   | the message                                                                                                                                                       | `sdk-process.ts:77`–`:92`, `session.ts:296`                                |
| stdout line whose `type` starts with `control_` or is any other string (`command_lifecycle`, a future type)                                                                                           | `recv`   | `wire`                  | the message                                                                                                                                                       | `sdk-process.ts:77`–`:92`, `session.ts:253`; `session.process.test.ts:213` |
| … except `control_cancel_request`                                                                                                                                                                     | `recv`   | `sdk`                   | the message; it also cancels the pending interaction                                                                                                              | `session.ts:247`–`:253`                                                    |
| stdout JSON whose `type` is not a string (`null`, `[]`)                                                                                                                                               | `recv`   | `wire`                  | the value                                                                                                                                                         | `sdk-process.ts:73`–`:76`                                                  |
| stdout line that is not JSON                                                                                                                                                                          | `recv`   | `wire`                  | `{type: "malformed_stdout", line}`                                                                                                                                | `sdk-process.ts:66`–`:71`; `session.process.test.ts:232`                   |
| a control request or response ace wrote                                                                                                                                                               | `send`   | `wire`                  | the message                                                                                                                                                       | `sdk-process.ts:119`–`:123`                                                |
| a user message ace wrote                                                                                                                                                                              | `send`   | `sdk`                   | the message                                                                                                                                                       | `session.ts:412`                                                           |
| stderr line                                                                                                                                                                                           | `stderr` | `sdk`                   | the line (a JSON string)                                                                                                                                          | `sdk-process.ts:104`, `session.ts:246`                                     |
| `can_use_tool` asked                                                                                                                                                                                  | `recv`   | `can_use_tool`          | `{toolName, input, options}`: `options` holds `CanUseTool`'s option fields other than `signal`, in `[d.ts]` order, with `requestId` = the envelope's `request_id` | `pending-interactions.ts:61`–`:81`, `:158`                                 |
| `elicitation` asked                                                                                                                                                                                   | `recv`   | `elicitation`           | `{requestId, request, native}`: `request` is ace's `InteractionRequest` (`pending-interactions.ts:95`–`:105`), `native` is `ElicitationRequest`                   | `:82`–`:121`                                                               |
| an interaction answered                                                                                                                                                                               | `send`   | its channel             | `{requestId, result, resolution}`                                                                                                                                 | `pending-interactions.ts:135`–`:147`                                       |
| an interaction cancelled (signal or `control_cancel_request`) or expired (close, exit)                                                                                                                | `recv`   | `interaction_lifecycle` | `{requestId, state}`                                                                                                                                              | `pending-interactions.ts:135`–`:147`                                       |
| `request_user_dialog` asked                                                                                                                                                                           | `recv`   | `user_dialog`           | the `UserDialogRequest` (`dialogKind`, `payload`, `toolUseID?`), then answered `{behavior: "cancelled"}`                                                          | `session.ts:275`–`:278`; **Q6**                                            |
| a `SubagentStart` or `SubagentStop` hook fired                                                                                                                                                        | `recv`   | `observational_hook`    | the hook's `input`                                                                                                                                                | `session.ts:220`–`:239`                                                    |
| the session started                                                                                                                                                                                   | `note`   | `lifecycle`             | `{type: "process.started", session_id, process_id, cwd}`                                                                                                          | `session.ts:126`–`:131`                                                    |
| `initialize` answered                                                                                                                                                                                 | `note`   | `commands.runtime`      | `{type: "system", subtype: "init", slash_commands}`                                                                                                               | `session.ts:324`–`:332`                                                    |
| …                                                                                                                                                                                                     | `note`   | `catalog.runtime`       | `{method: "agent.list", result: {data}, cwd}`                                                                                                                     | `session.ts:340`–`:350`                                                    |
| `get_usage` answered, or `onRateLimit` threw                                                                                                                                                          | `note`   | `accounts`              | the usage reading, or `{type: "rate_limit_observation_failed"}`                                                                                                   | `usage-read.ts:101`–`:113`, `session.ts:298`–`:306`                        |
| `interrupt` answered                                                                                                                                                                                  | `note`   | `interrupt_receipt`     | the receipt                                                                                                                                                       | `session.ts:448`                                                           |

The mapping from a `can_use_tool` request to `options` renames snake_case to the `CanUseTool`
names (`permission_suggestions` → `suggestions`, `blocked_path` → `blockedPath`, `decision_reason`
→ `decisionReason`, `title`, `display_name` → `displayName`, `description`, `default_to_no` →
`defaultToNo`, `suppress_always_allow_rule` → `suppressAlwaysAllowRule`, `mcp_server` →
`mcpServer`, `tool_use_id` → `toolUseID`, `agent_id` → `agentID`, `matched_ask_rule` →
`matchedAskRule` with `tool_name` → `toolName` and `rule_content` → `ruleContent`), omitting
absent fields. `elicitation` likewise (`mcp_server_name` → `serverName`, `elicitation_id` →
`elicitationId`, `requested_schema` → `requestedSchema`, `display_name` → `displayName`). Both
sides are `[d.ts]` names; `[test]` pins `title`, `description`, `defaultToNo`,
`suppressAlwaysAllowRule`, `mcpServer`, `suggestions`, `requestId` and `serverName`, and the
recording `approval-edit.jsonl` seq 57 shows `suggestions`, `displayName`, `description`,
`toolUseID` and `requestId` together. Fields `[d.ts]` doesn't list on the callback side stay only in
the raw `wire` frame that precedes the `can_use_tool` frame, as today.

**Order.** Each stdout line yields its frames in line order, and a line's frames come before any
frame a later line causes. For a permission that is: `recv`/`wire` (the request), `recv`/`can_use_tool`,
then on answer `send`/`can_use_tool` and `send`/`wire` (the response). A user message's
`send`/`sdk` frame follows its write (rule 16).

**Intended differences** (TypeScript defects fixed in the Rust only, recorded here; owner rule,
2026-11-24):

1. Today a known-type line reaches its frame through the SDK's asynchronous stream while a `wire`
   line is framed at once (`sdk-process.ts:63`–`:99`), so a later control line can be framed
   before an earlier message. Native frames follow line order.
2. `late_stdout` (`sdk-process.ts:94`–`:98`) exists only because the SDK's stream ends at exit
   while lines still wait. The native session reads to the terminal barrier, so every line before
   `close` is framed normally and no `late_stdout` frame is produced.
3. `malformed_stdin` (`sdk-process.ts:125`) can't happen: Rust encodes every line it writes.
4. Today's `send`/`sdk` frame is recorded at the push into the SDK's queue (`session.ts:410`–`:412`),
   before the bytes reach the pipe. Native records it after the write (rule 16), as Pi does.
5. Today a stdin line over 16 MiB fails inside the SDK's write after the push, and ace stops the
   CLI at once (`sdk-process.ts:107`–`:114`), so the send has already counted as pushed and the
   session dies. Native measures each encoded line at admission and refuses the whole send with
   `InputRejected("Claude outbound frame capacity reached")` before any byte is written; the CLI
   keeps running. A control request over the bound is refused the same way.

## 3. The crate and its public API

### Name and terms

**`agent-stream-json`** (`native/daemon/crates/agent-stream-json`, crate `agent_stream_json`). It
names the protocol, not the vendor: never `claude-code-*` or `anthropic-*`. `publish = false`
until the owner decides to publish (**Q9**). Its `Cargo.toml` description and its crate docs say:

> Drives an agent CLI that speaks the stream-json control protocol, run as a subprocess the way
> the provider's documentation describes. It never handles credentials: the CLI signs itself in.
> A product built on this crate for other people should have those people authenticate the CLI
> with their own API key, as the provider's terms ask.

### Layers

1. **`agent-stream-json`**: the protocol, sans-IO. Builds `argv` and messages, classifies
   received lines, correlates control requests and responses, maps the CLI's requests to their
   host shapes. Depends on `ace-json` (rule 8: JavaScript-exact JSON) and `thiserror` only. No
   tokio, no clock, no process, no ace crate besides `ace-json`.
2. **`ace-adapter-claude/src/session/`**: ace's session over the crate, sans-IO too: framing,
   capture (elision, redaction, admission), channels, task index, interactions, session
   confirmation, effects. Then `io.rs`, the thin shell: an `OutputConsumer` over the E3.0b
   diverted child, as `ace-adapter-pi/src/session/io.rs` is for `PiWire`.
3. **`ace-daemon-node/src/session_claude.rs`** and **`packages/adapter-claude/src/native-session.ts`**:
   binding and facade, translating values and nothing else (rule 7).

### `agent-stream-json`

```rust
// launch.rs — argv, in this order, `--flag=value` for valued flags (the pinned forms).
pub struct Launch {
    pub session: SessionStart,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub allow_dangerously_skip_permissions: bool,
    /// None: no flag (the CLI's defaults). Some(vec![]): see Q4.
    pub setting_sources: Option<Vec<String>>,
    pub strict_mcp_config: bool,
    /// A path, or inline JSON `{"mcpServers": …}`. The caller swaps inline JSON for a private file.
    pub mcp_config: Option<String>,
    pub plugin_dirs: Vec<String>,
    pub include_partial_messages: bool,
    pub include_hook_events: bool,
    /// Flags the caller adds verbatim (`chrome` → `--chrome`), in insertion order.
    pub extra: Vec<(String, Option<String>)>,
}
pub enum SessionStart {
    New { session_id: String },
    Resume { session_id: String },
    Fork { source: String, at: Option<String>, session_id: String },
}
pub fn args(launch: &Launch) -> Vec<String>;

// message.rs — one received line, already parsed once by the caller.
pub enum Line {
    /// One of the eleven message types of section 2. `value` is the line, moved, never cloned.
    Message { kind: MessageKind, value: ace_json::Value },
    /// A request the CLI asks the host to answer.
    HostRequest { request_id: String, request: HostRequest, value: ace_json::Value },
    /// The answer to a control request this side sent.
    ControlResponse { request_id: String, outcome: Outcome, value: ace_json::Value },
    Cancel { request_id: String, value: ace_json::Value },
    /// A string `type` this crate doesn't know, or none: kept whole, never an error.
    Unknown { value: ace_json::Value },
}
pub enum MessageKind { System, Assistant, User, Result, StreamEvent, RateLimitEvent, KeepAlive,
                       ToolProgress, ToolUseSummary, AuthStatus, PromptSuggestion }
pub enum HostRequest {
    CanUseTool, Elicitation, UserDialog,
    HookCallback { callback_id: String },
    /// A `control_request` subtype this crate doesn't know. The host answers it with an error
    /// or leaves it (Q10); it is never fatal.
    Other { subtype: String },
}
pub enum Outcome { Success, Error(String) }
pub fn classify(value: ace_json::Value) -> Line;

// control.rs — requests this side sends, and their correlation.
pub enum Request {
    Initialize(Initialize),
    Interrupt { cancel_queued: bool },
    SetModel(Option<String>),
    SetPermissionMode(String),
    ApplyFlagSettings(ace_json::Map),
    StopTask(String),
    BackgroundTasks { tool_use_id: Option<String> },
    McpStatus,
    McpSetServers(ace_json::Map),
    McpReconnect(String),
    McpToggle { server: String, enabled: bool },
    GetUsage { skip_behaviors: bool },
}
pub struct Initialize {
    /// `(event, callback ids)` in insertion order; the ids are this side's own.
    pub hooks: Vec<(String, Vec<String>)>,
    pub append_system_prompt: Option<String>,
    pub forward_subagent_text: bool,
    pub per_task_stop_affordance: bool,
}
/// No count cap: the bound is the caller's outbound byte budget (one line at most 16 MiB).
pub struct Controls { /* next id (`ace-<n>`), pending: IndexMap<String, u64>, closed */ }
impl Controls {
    pub fn new() -> Controls;
    /// The envelope to write, its request id, under the caller's `tag`.
    pub fn request(&mut self, request: Request, tag: u64) -> Result<(String, ace_json::Value), ControlError>;
    /// Which tag a response settles; None for an id nobody is waiting on (kept as a wire frame).
    pub fn settle(&mut self, request_id: &str) -> Option<u64>;
    /// Every tag still pending, for closing.
    pub fn drain(&mut self) -> Vec<u64>;
}
pub enum ControlError { Closed }

// host.rs — answers to the CLI's requests, and their host shapes.
pub fn success(request_id: &str, response: ace_json::Value) -> ace_json::Value;
pub fn error(request_id: &str, message: &str) -> ace_json::Value;
/// `can_use_tool` request → `CanUseTool`'s options (section 2), `requestId` included.
pub fn permission_options(request: &ace_json::Map, request_id: &str) -> ace_json::Map;
pub fn elicitation_request(request: &ace_json::Map) -> ace_json::Map;
pub fn user_dialog_request(request: &ace_json::Map) -> ace_json::Map;

// user.rs
pub fn user_message(uuid: &str, session_id: &str, content: ace_json::Value, priority: &str,
                    synthetic: bool) -> ace_json::Value;
```

Rules for the crate: nothing returns `Result` on data the CLI sent (classification is total);
nothing clones a `Value`; nothing reads the clock or spawns; key order of every built message is
the order written above, which is the order the fake echoes and the fixture shows (`[fx]` seq 2:
`request_id`, `type`, `request` with `subtype` first). Whether that order is the SDK's own is not
knowable and doesn't matter: the CLI parses JSON.

### `ace-adapter-claude/src/session/`

```rust
pub enum Effect {
    Frame { dir: FrameDir, channel: &'static str, text: String }, // redacted, elided, admitted
    Write { wire: Vec<u8> },                                     // original bytes + "\n"
    Settle { id: u64, result: Result<String, ClaudeError> },
    Callback { name: &'static str, json: String },               // onSessionConfirmed, onInputMessage, onRateLimit, hook:UserPromptSubmit
    ArmTimer { key: String, ms: f64 }, CancelTimer { key: String },
    Fatal { message: String },
    Drained,
}
pub struct ClaudeWire { /* framers, Controls, tasks, interactions, hooks, capture config */ }
impl ClaudeWire {
    pub fn new(config: WireConfig) -> ClaudeWire;   // session id, root key, bearer, hook ids
    pub fn stdout_bytes(&mut self, bytes: &[u8]) -> Vec<Effect>;
    pub fn stderr_bytes(&mut self, bytes: &[u8]) -> Vec<Effect>;
    pub fn stdin_written(&mut self) -> Vec<Effect>;
    pub fn stdin_error(&mut self, message: &str) -> Vec<Effect>;
    pub fn write_refused(&mut self) -> Vec<Effect>;
    pub fn control(&mut self, request_json: &str, id: u64) -> Result<Vec<Effect>, ClaudeError>;
    /// One synchronous admission: every message is encoded and checked before the first write.
    pub fn send(&mut self, messages_json: &str, command_id: Option<&str>) -> Result<Vec<Effect>, ClaudeError>;
    pub fn peek_interaction(&self, id: &str) -> Option<String>;
    pub fn answer_interaction(&mut self, id: &str, result_json: &str, resolution_json: &str) -> (bool, Vec<Effect>);
    pub fn answer_hook(&mut self, request_id: &str, output_json: &str) -> Vec<Effect>;
    pub fn task_target(&self, spawn: &str) -> Option<String>;            // SessionTasks.resolve, JSON
    pub fn task_cascade(&self, spawn: Option<&str>) -> String;           // {ids, uncertain}
    pub fn note(&mut self, json: &str) -> Vec<Effect>;
    pub fn timer(&mut self, key: &str) -> Vec<Effect>;
    pub fn expire(&mut self) -> Vec<Effect>;                             // close or exit
    pub fn finish(&mut self) -> Vec<Effect>;                             // terminal barrier, ends with Drained
}
pub enum ClaudeError { Refused(String), Uncertain(String), Provider(String) }
// codes: ACE_INPUT_REJECTED, ACE_CLAUDE_UNCERTAIN, ACE_CLAUDE_CONTROL
```

`ClaudeError::Refused` is "nothing reached the CLI" (the facade throws `InputRejected`, as
`session.ts:413`–`:419` decides with `pushed === 0`); `Uncertain` is "bytes may have reached it"
(a plain `Error`); `Provider` is an error response, rejected with the CLI's text.

### How unknown messages surface

- An unknown stdout `type`, or a line with none: a `recv`/`wire` frame, nothing else.
- An unknown `control_request` subtype: a `recv`/`wire` frame. It is not answered until **Q10** is
  settled; it is never fatal.
- A response whose `request_id` nobody waits on: a `recv`/`wire` frame.
- A `system` subtype the translator doesn't know: a `recv`/`sdk` frame, as the fake's
  `fake_control` is today; the translator keeps it as a raw signal (`translate/raw_facts.rs`).
- A known message missing a field the session reads (`session_id`, `request_id`): the frame is
  kept; the session's own use of it is skipped, as `string()` returning `""` skips it today.

## 4. The hot path: each line is parsed once

ACP's native session benched at 1.44× TypeScript CPU because each frame was parsed twice,
serialized once and deep-copied three times. Pi is cheaper: it parses each line in one place and
forwards the text, never a decoded tree (`ace-adapter-pi/src/session/wire.rs:748`, `admit_payload`).
Claude follows Pi's pattern, and with one tree instead of Pi's tree plus raw view.

Today one assistant delta costs: `JSON.parse` in `sdk-process.ts:67`; a write of the text into the
SDK's stream and the SDK's own parse; `JSON.stringify` in `elidedJson` (`session.ts:86`–`:87`, twice for
long lines); `JSON.parse` in `ProviderPayload`; and with `ACE_TRANSLATORS=claude`, `JSON.stringify`
again in `native-translator.ts:66`–`:72` and a Rust parse.

The native path, per stdout line:

| Step               | Where                                                                                                                                       | Cost                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| framing            | `ClaudeWire::stdout_bytes` → `ace_supervisor::jsonl::JsonLines::new(16 MiB)`                                                                | no parse                                                                                                                                     |
| **the one parse**  | `session/wire.rs`, `stdout_line`: `ace_json::parse(line)`                                                                                   | the only parse of the line in Rust                                                                                                           |
| classification     | `agent_stream_json::classify(value)`                                                                                                        | reads `type`, `request_id`, `request.subtype` on the tree; moves it                                                                          |
| structural bound   | `session/capture.rs`, the same tree, one linear pass                                                                                        | the 32,768-node count of `ProviderPayload` (`payload.ts:25`–`:28`); elision and redaction never change the shape, so it equals today's count |
| capture text       | `capture.rs`: `ace_adapter_api::util::binary_elision::elided_json(&value)`, then the bearer replaced in the text, then the 1 MiB byte bound | one serialization                                                                                                                            |
| protocol state     | `session/core.rs`: confirmation, tasks, interactions read the same tree by reference                                                        | no copy                                                                                                                                      |
| a settle's payload | `Value::take` of `response` after the capture is written                                                                                    | a move; its JSON text is written once for the bridge                                                                                         |
| to JavaScript      | the frame text, once per batch (E3.0c)                                                                                                      | `ProviderPayload` parses it once in JS, as for every native session until E5                                                                 |

Must-nots on this path: no `serde` decode of a line (no typed struct for a message), no
`parse_raw` or second `ace_json::parse` of the same text, no `Value::clone` of a line or of its
response, no re-serialization after redaction. The redaction is a text replacement exactly like
`redactMcpCredential` (`mcp-server/src/injection.ts:212`–`:214`). A test can't see these, so the
reviewer checks them by reading `stdout_line` and the bench (E3-claude.5) shows them.

Until E5, a frame still crosses into JavaScript once, and with `ACE_TRANSLATORS=claude` the
TypeScript engine hands it back to the native translator as `JSON.stringify(frame.data)`. That
round trip belongs to the TypeScript engine, not the session (ADR 0223, "Native both"). **Q11**
offers a small way to drop the `JSON.stringify`.

## 5. Scope

**In scope**: the session behind `openSession` (`session.ts`), with `sdk-process.ts`'s
session-side behaviour, `pending-interactions.ts`'s state, `session-tasks.ts`, `input.ts`'s
`InputStream` capacity, and the control half of `mcp-controls.ts`.

**`metadata-host.ts` stays a JavaScript child for now.** It already runs outside the daemon
(`metadata-host-client.ts:40`–`:51`, its own release bundle `tools/release/src/bundle.ts:254`), so
moving it gains no daemon heap or CPU, which are what the T7 gate and the daemon bench measure.
It runs two questions on a short-lived, prompt-less CLI, and its process ownership is subtle
(the helper reports the CLI's pid and the daemon adopts its group, `metadata-host-client.ts:57`–`:78`,
with a Windows tree stop). Its tests are class "—" and stay TypeScript (behaviour.md §19). Once
E3-claude is default-on, the same two questions are a `Controls` round trip over the crate
(`initialize` → `models`, `get_usage`), so a later item can replace the child without the SDK. One
part of it does reach the daemon process today: with an injected `spawn` (tests only) it runs
`askClaude` in process (`metadata-host-client.ts:31`), which loads the SDK. ADR 0226 §5 gate 3
needs that path gone from the daemon's production graph before T7; it is listed for that later
item, not built here.

**`fork-worker.ts` stays a JavaScript child.** `forkSession` copies a transcript on disk without
starting the CLI (`fork.ts:9`). The transcript format isn't in the published docs, so porting it
would mean learning it from the SDK's implementation, which the clean room forbids. The
documented alternative, `--resume <id> --fork-session` `[cli]`, starts the CLI, which `fork.ts`
promises not to do. It is already a child with its own bundle (`bundle.ts:253`).

**Not moved**: `tools/recorder` (never run for this work), the zod schemas at the boundary
(`InteractionResolution`, `ElicitationAnswer`, `ClaudeMcpServers`, `ClaudeSelectionOptions`,
`ClaudeRateLimitObservation`): the facade keeps parsing with them, so zod's code-point bounds stay
exact (rule 17) without porting them.

## 6. Open questions for the owner

1. **Does the SDK yield each known-type line unchanged?** The frame contract assumes a `recv`/`sdk`
   frame's data equals the CLI's line. The recordings show the SDK's output only, and
   `tools/daemon-bench`'s fake already makes the same assumption (it replays recorded frames as CLI
   lines). If the SDK adds, renames or drops fields (or drops `keep_alive`), frames change. Proposal:
   accept the assumption, since the translator tests replay the fixtures either way and the
   session tests compare against the fake's own lines.
2. **The full argv for host mode.** The docs give `-p --input-format stream-json --output-format
stream-json --verbose`. Whether the CLI also needs a flag to send `can_use_tool` to stdin (the
   docs' `--permission-prompts host` is the default) isn't documented, and ace's fake can't tell.
   Settling it needs one look at a real CLI. Options: (a) the owner runs one prompt-less handshake
   of the installed `claude` (no turn, no quota) and ace records its output as a new fixture;
   (b) ask Anthropic; (c) build without it and find out in the opt-in release. Recommended: (a).
3. **Environment.** Whether the SDK adds variables to the child's environment (beyond ace's
   `CLAUDE_AGENT_SDK_CLIENT_APP`, `session.ts:241`) isn't documented. The native session passes
   exactly ace's environment. Settled with Q2's recording if (a).
4. **The isolated configuration** (`configuration.ts:33`–`:38`): what "no `systemPrompt`" (the
   SDK's "minimal prompt") and `settingSources: []` become on the wire. Only sessions in tests use
   it (`sdk-controls.process.test.ts:127`); production sessions use `coding`. Proposal: pass
   `--setting-sources=` (empty) and, for the prompt, Q2's recording; until then the isolated case is
   built from `[test]` alone and marked.
5. **User message fields.** The native session writes exactly ace's object (`session.ts:388`–`:401`).
   If the SDK adds fields when it writes it, they are lost. The docs list none that it adds
   (`client_composed` only with `verbatimPrompts`). Proposal: accept.
6. **`request_user_dialog`.** `[d.ts]` says a host declares the kinds it renders in
   `initialize.supportedDialogKinds` and must not answer kinds it didn't declare, while the
   callback type says hosts answer unknown kinds `{behavior: "cancelled"}`. Today's recording shows
   no `supportedDialogKinds`, and ace answers `cancelled` (`session.ts:277`). Proposal: keep
   today's answer and send no `supportedDialogKinds`; the `user_dialog` frame's data is built as the
   `UserDialogRequest` names (`dialogKind`, `payload`, `toolUseID`), which no test pins.
7. **`mcp_status`'s response key** (`mcpServers`) comes from ace's fake only. Proposal: accept; the
   reconnect logic and its test depend on it already.
8. **`get_usage {skip_behaviors}`.** The field name is `[d.ts]`'s; the experimental method's
   mapping isn't documented. Proposal: accept, and keep the read best-effort as today (a failure is
   silent, `usage-read.ts:106`–`:112`).
9. **Publishing `agent-stream-json`.** It depends on `ace-json`, which would have to be published
   too (or the crate made generic over a JSON value) before it can go to crates.io. Decide when
   publishing comes up; nothing here blocks on it.
10. **Unknown `control_request` subtypes.** Today the SDK decides what to answer; ace can't see it.
    Leaving one unanswered can stall the CLI; answering with an error might be wrong for a request
    the CLI treats as optional. Proposal: answer `{subtype: "error", error: "Unsupported control
request: <subtype>"}` (the envelope of `[d.ts]`), and keep the request as a `wire` frame.
11. **The translator's `JSON.stringify`.** With `ACE_TRANSLATORS=claude`, a native frame's text
    is parsed in JS and then stringified again for the native translator. Keeping the text on
    `ProviderPayload` (`provider-kit/src/payload.ts`) and having `native-translator.ts` send it would
    save that serialization for every provider. It changes a shared class, so it is not in these
    items. Approve as a separate item?
12. **A Claude restart test.** No test reboots a home with a real Claude session (the engine's
restart files use scripted adapters), so the E3 cross-mode gate has nothing to run for Claude.
As for Pi (E3-pi.2b), E3-claude.6 asks for one new test. Approve?
</content>

</invoke>

### Answers (2026-11-25)

The owner approved one prompt-less handshake of the installed `claude` 2.1.331 and the restart
test. The recording is [fixtures/claude/handshake-2.1.331](../../fixtures/claude/handshake-2.1.331/README.md).

1. Accepted: a known-type line's data is the CLI's line.
2. **Settled by the recording.** `canUseTool` becomes `--permission-prompt-tool stdio`. The full
   host-mode argv is `--output-format stream-json --verbose --input-format stream-json
--permission-prompt-tool stdio`, then `--setting-sources=<list>`, `--strict-mcp-config` (isolated
   only), `--include-hook-events` and `--include-partial-messages`, in that order
   (`argv.coding.json`, `argv.isolated.json`). Options the recording didn't set (model, resume,
   session id, MCP config, effort, permission mode, extra args) follow the docs.
3. **Settled.** The SDK adds `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` and nothing else; `PWD`
   follows `cwd` and `OLDPWD` is dropped (`env-added.json`). The native session adds the same
   variable to ace's environment.
4. **Settled.** No system prompt is `"systemPrompt": [""]` in the `initialize` request, not a flag;
   the `claude_code` preset sends no `systemPrompt` field. Empty `settingSources` is
   `--setting-sources=`. The isolated case is built from the recording, no longer marked.
5. Accepted.
6. Accepted: answer `cancelled`, send no `supportedDialogKinds`. The recorded `initialize` request
   carries none either.
7. Accepted.
8. Accepted, best-effort as today.
9. Deferred until publishing comes up.
10. Accepted: an error reply with the `[d.ts]` envelope, and the request kept as a `wire` frame.
11. Approved as a separate item after E3-claude.4, for every provider, with its bench.
12. Approved (the owner): E3-claude.6 adds the one restart test, on E3-pi.2b's terms.
