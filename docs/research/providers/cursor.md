# Cursor Agent (Cursor CLI / `cursor-agent`): provider research for ace

Researched 2026-10-01/02. Version inspected: `cursor-agent` / `agent` **2026.09.26-dd393fe** (`agent --version`), installed at `~/.local/share/cursor-agent/versions/2026.09.26-dd393fe/`. The CLI is a webpack-bundled Node app (`index.js` plus numbered chunks) launched by a bash shim (`cursor-agent` sets `CURSOR_INVOKED_AS` and runs the bundled `node index.js`).

Citation shorthand:

- `B:<chunk>/<module>` is a source module inside the minified bundle chunk `~/.local/share/cursor-agent/versions/2026.09.26-dd393fe/<chunk>.index.js`. Each chunk is a single line, so I cite the webpack module key (for example `5672/src/acp/agent-session.ts`) and the symbol, not line numbers. The ACP server lives in chunk `5672`. Chunk `8096` bundles `@agentclientprotocol/sdk@0.14.1`. Headless/stream-json lives in `9352/src/headless.ts`.
- `ACP:<path>` is a file in `github.com/agentclientprotocol/agent-client-protocol` at tag **`schema-v1.24.1`** (released 2026-09-30), for example `ACP:schema/v1/schema.unstable.json#SubagentUpdate`.
- `docs/<page>` is `https://cursor.com/docs/<page>`, fetched 2026-10-01. The docs were read through a summarizing fetcher, so quotes are close to the original but may not be exact.
- **[probe]** marks claims verified by sending only `initialize` and non-prompt methods to `agent acp` from an empty directory. No session was created and no prompt was sent.
- **[unverified]** marks claims taken from code reading or docs that have not been checked against a live session.

---

## TL;DR

**Recommendation.** Use **ACP over stdio (`agent acp`) as the primary live surface**. Run one process per ace thread (more precisely, per cwd), and advertise `clientCapabilities._meta.subagents = {}` and `_meta.parameterizedModelPicker = true`. Implement Cursor's `cursor/*` extension requests. Use the **on-disk Claude-Code-style transcripts** (`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` plus `subagents/<agentId>.jsonl`) as the secondary surface for history import. Use **headless `-p --output-format stream-json`** only for fire-and-forget batch runs. It has no human-in-the-loop channel. Treat the Cloud Agents API as a separate, future "remote Cursor" provider.

Key facts:

1. **ACP is a hidden but supported subcommand.** `agent acp` is registered with `{hidden:!0}` (`B:index.js`, `Ee.command("acp",{hidden:!0})`), so it doesn't appear in `agent --help`. It is documented at docs/cli/acp. Cursor's ACP is built on SDK **0.14.1**, while the current SDK on npm is 1.6.0. It speaks protocol version 1 **[probe]**.
2. **Cursor exposes a real agent tree over ACP, but only on request and in a non-standard shape.** When the client sets `clientCapabilities._meta.subagents`, Cursor emits custom `session/update` variants `subagent_spawned` and `subagent_state_update` (`completed|failed|cancelled|disconnected`) on the parent session. Each child's own updates then stream on a child `sessionId` (`B:5672/src/acp/session-resources.ts`, class `G`). This is **not** the ACP RFD's `subagent_update` (`ACP:docs/rfds/subagents.mdx`). A top-level `clientCapabilities.subagents` is **silently stripped** by the SDK, so only `_meta.subagents` works **[probe]**.
3. **The `session/prompt` response is not "done", and `end_turn` is not "success".** Cursor returns only `end_turn` or `cancelled`. Backend and runtime errors become an `agent_message_chunk` with the text `"\n\nError: …"` followed by `end_turn` (`B:5672/src/acp/agent-session.ts`, `processPrompt` catch). Without the subagent capability, background subagents and shells keep running after `end_turn`.
4. **Tool calls are never marked `failed`.** Every completion is `tool_call_update{status:"completed"}`. Failure is only visible in `rawOutput` (`{error}`, `{exitCode,stderr}`, `{rejected}`, `{permissionDenied}`) (`B:5672/src/acp/session-update-presenter.ts`, `tool-call-presentation.ts`). The raw tool name (`shellToolCall`, `editToolCall`…) is **not** sent. You only get ACP `kind`, a title string, and a curated `rawInput`.
5. **Human-in-the-loop is good.** `session/request_permission` (fixed options `allow-once`/`allow-always`/`reject-once`) covers shell, write, delete, MCP, web search and web fetch. Blocking extension requests `cursor/ask_question` and `cursor/create_plan` cover questions and plan review. If the client doesn't implement them, Cursor degrades: questions are sent as permission prompts, and plans are auto-accepted and written to disk.
6. **There is no mid-turn steering over ACP.** A new `session/prompt` on a busy session **cancels** the running turn first (`handlePrompt` calls `pendingPromptCancel`). `session/resume`, `session/fork` and `session/close` return `-32601` **[probe]**. `session/load` replays history but only for ACP-created sessions (`~/.cursor/acp-sessions/<id>/store.db`), not TUI chats.
7. **ACP gives no token usage, rate-limit or reconnect signals.** `usage_update` is never sent, and connection-state changes only reach `debugLog`. Stream-json does carry `usage`, `retry` and `connection` events (`B:9352/src/headless.ts`).
8. **Version churn is high.** The public docs lag the code. For example, docs say stream-json suppresses thinking, but the code emits `thinking` delta/completed. Docs call `cursor/update_todos`/`cursor/task`/`cursor/generate_image` notifications, but the code sends them as JSON-RPC **requests** via `extMethod`. Gate on `agent --version` and feature-detect.

---

## 1. Integration surfaces

| Surface                                                                                                                              | What it gives                                                                                                                                                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ACP** `agent acp` (JSON-RPC 2.0 NDJSON over stdio; docs/cli/acp)                                                                   | Multi-session server. Streaming text and thought chunks, tool calls with diffs, permissions, Cursor question/plan/todo/task extensions, modes, models, `session/list`, `session/load` with replay, `session/cancel`, and a subagent tree (opt-in)                                                                                                                              | **Primary**                                                                                                                                                                                                                                                                                                                                                                                         |
| **Headless** `agent -p --output-format stream-json [--stream-partial-output]` (docs/cli/reference/output-format)                     | One turn per process. Typed protobuf-JSON tool payloads (`tool_call.<case>.args/result`), `usage`, `request_id`, `retry`/`connection`/`interaction_query`/`task_notification` events (`B:9352/src/headless.ts`)                                                                                                                                                                | Secondary, for unattended runs only. No approvals: decisions come from `--force`/allowlist, and questions are auto-rejected (`B:3732/src/utils/interaction-responses.ts`). Subagent internals are not emitted                                                                                                                                                                                       |
| **On-disk transcripts** `~/.cursor/projects/<path-slug>/agent-transcripts/<chatId>/<chatId>.jsonl` and `…/subagents/<agentId>.jsonl` | Claude-Code-compatible JSONL: `{role, message:{content:[text                                                                                                                                                                                                                                                                                                                   | tool_use{name,input}]}}`plus`{type:"turn_ended",status,error?}` (local inspection). Model-facing tool names (`Read`, `Grep`, `StrReplace`, `Shell`, `Task`, `Subagent`, `Await`, `AwaitShell`, `TodoWrite`, `AskQuestion`, `CreatePlan`, `SwitchMode`, `WebSearch`, `WebFetch`, `CallMcpTool`…). Changelog Feb 2026: "headless transcripts write Claude Code-compatible JSONL" (docs/cli/changelog) | **Secondary**, for history import and subagent transcripts. No tool results observed, so it is lossy |
| Chat stores `~/.cursor/chats/<hash>/<id>/store.db`, `~/.cursor/acp-sessions/<id>/store.db`                                           | SQLite `blobs(id,data)` + `meta(key,value)`. `meta['0']` is hex JSON `{agentId, latestRootBlobId, name, mode, isRunEverything, createdAt}`. Blobs are content-addressed protobuf (local inspection)                                                                                                                                                                            | Don't parse. Opaque and internal                                                                                                                                                                                                                                                                                                                                                                    |
| **Hooks** `~/.cursor/hooks.json`, `<proj>/.cursor/hooks.json` (docs/agent/hooks)                                                     | `sessionStart/End`, `pre/postToolUse`, `subagentStart/Stop`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`, `stop`, `preCompact`, `afterAgentResponse/Thought`. Common fields include `conversation_id`, `generation_id`, `transcript_path`. Hooks run in the CLI and in ACP (the ACP session wires a hook executor, `session-resources.ts`) | Enrichment only. They are user-owned config, so ace shouldn't depend on them                                                                                                                                                                                                                                                                                                                        |
| **Cloud Agents API** `api.cursor.com/v1/agents…` (docs/cloud-agent/api/endpoints)                                                    | REST plus SSE run stream (`status, assistant, thinking, tool_call, interaction_update, heartbeat, result, error, done`). Agent status `ACTIVE/IDLE/ARCHIVED`. Follow-ups via `POST /v1/agents/{id}/runs`. Webhooks "coming soon" in v1                                                                                                                                         | Separate remote provider later. Not for local runs                                                                                                                                                                                                                                                                                                                                                  |
| `agent worker`                                                                                                                       | Self-hosted Cloud Agent worker (`agent help worker`)                                                                                                                                                                                                                                                                                                                           | Out of scope                                                                                                                                                                                                                                                                                                                                                                                        |

**Why ACP is primary.** It is the only local surface with a bidirectional human-in-the-loop channel, multiple turns per process, cancel, resume, mode and model control, and per-subagent transcripts. Stream-json is richer per tool call: it has full protobuf args and results and the real case name. But it is single-shot, cannot ask the user anything, and hides subagent internals.

---

## 2. Launch, auth, process model

- **Launch.** Run `agent [global flags] acp`. The subcommand takes no options of its own (`agent help acp`). Global flags placed **before** `acp` are read via `ke()` in the acp action (`B:index.js`). These include `--api-key`/`CURSOR_API_KEY`, `-e/--endpoint`, `-H`, `--force/--yolo`, `--trust`, `--sandbox`, `--approve-mcps`, `--auto-review` and `--worktree`. `--force` sets `isRunEverything` on the session, unless the team admin disabled "Run Everything", in which case the allowlist applies (`B:5672/src/acp/agent-store.ts`, `session-resources.ts` `K`). Hidden flags exist and are unstable: `--auth-token`, `--data-dir` (sets `CURSOR_DATA_DIR`), `--show-thinking`, `--single-turn`, `--background-shell-timeout`, `--debug` (`B:index.js` option table).
- **Auth.** Run `agent login` beforehand. You can also use an API key or auth token. ACP advertises the single method `cursor_login` **[probe]**. `session/new`, `session/load` and `session/list` throw `authRequired` unless the process started authenticated. `authenticate{methodId:"cursor_login"}` opens a browser login if needed (`B:5672/src/acp/cursor-acp-agent.ts`, `authenticate`). The process is treated as authenticated when there is a stored login, `--api-key`, `CURSOR_API_KEY` or `--auth-token` (`B:5672/src/acp/run.ts`). Pre-flight check: `agent status --format json` gives `{status,isAuthenticated,hasAccessToken,hasRefreshToken,userInfo}`, and `agent about --format json` gives `{cliVersion,latestVersion,model,subscriptionTier,…}` (local run, values not printed).
- **Workspace trust.** The interactive and print paths block with "Workspace Trust Required" unless `--trust/--yolo/-f` is passed (observed). **The `acp` action skips the trust prompt** (it only trusts when a worktree is set up), and `initialize` succeeded in an untrusted temp dir **[probe]**.
- **Process model.** One ACP process can host many sessions (`this.sessions` Map). **Still, run one process per session.** The model selection is process-global (`modelManager`, `syncSessionsToCurrentModel`) and persisted, and slash-command, skill and resource-link resolution uses `process.cwd()` rather than the session `cwd` (`agent-session.ts` `getProjectRoot`). Session MCP servers, permissions and subagent hosts are per session (`session-resources.ts`).
- **Models.** `agent models` / `--list-models`. Inside ACP, `session/new` returns `models` and `configOptions`. If `clientCapabilities._meta.parameterizedModelPicker===true`, Cursor returns a `model` select plus per-model parameter selects with categories `model_config`/`thought_level`. Otherwise it returns a flat "variants" list. The extension request `cursor/list_available_models` returns `{models:[{value,name,configOptions}]}` (`cursor-acp-agent.ts` `listAvailableModels`).
- **Version gating.** Use `agent --version` (format `YYYY.MM.DD-<sha>`) and `agent about --format json`. Release dates come from docs/cli/changelog: ACP model and mode selection (March 2026), subagents in the CLI (March 2026), editor-provided MCP servers trusted (May 20, 2026), single-turn runs wait for subagents (Aug 11, 2026). The CLI auto-updates (`agent update`), so ace should record the version at spawn time and treat unknown updates and methods as non-fatal.

---

## 3. Event stream

### 3a. ACP `session/update` variants Cursor actually emits

Sources: `agent-session.ts`, `session-update-presenter.ts`, `session-resources.ts`.

| Update                                      | When                                                                                                                 | Notes                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`                       | Every model `textDelta` (token-level)                                                                                | No `messageId`. **Also carries errors** (`"\n\nError: …"`, "Upgrade your plan to continue", etc.)                               |
| `agent_thought_chunk`                       | Every `thinkingDelta`                                                                                                | No end marker                                                                                                                   |
| `tool_call`                                 | First `partialToolCall` or `toolCallStarted`, with `status:"pending"`, `kind`, `title`, `rawInput`, `locations`      | `toolCallId` = Cursor `callId`                                                                                                  |
| `tool_call_update`                          | Shape refresh (title/rawInput/locations), `in_progress` on start, `completed` on finish with `content` + `rawOutput` | **Never `failed`**                                                                                                              |
| `plan`                                      | Only from `create_plan` (entries derived from plan todos)                                                            | Todo-list updates do **not** produce `plan`                                                                                     |
| `available_commands_update`                 | Shortly after new/load: `copy-request-id` plus custom commands and skills                                            |                                                                                                                                 |
| `current_mode_update`                       | After client `set_mode`/`set_config_option(mode)`                                                                    | Agent-initiated mode switches are auto-approved (`interaction-responses.ts`). Whether they emit this update is **[unverified]** |
| `session_info_update{title}`                | Async auto-naming after the first prompt                                                                             | Can arrive after the prompt response                                                                                            |
| `user_message_chunk`                        | Only during `session/load` replay                                                                                    |                                                                                                                                 |
| `subagent_spawned`, `subagent_state_update` | Only with `_meta.subagents` (§4)                                                                                     | Non-standard variants                                                                                                           |
| _never_                                     | `usage_update`, `config_option_update`, `plan_update`, `tool_call.status=failed`, terminal content                   | grep count 0 in chunk 5672                                                                                                      |

**Tool payloads.** `rawInput` is a hand-picked subset. For example, edit sends only `{path}`, shell sends `{command}`, MCP sends `{providerIdentifier,toolName,args}`, and task sends `{_toolName:"task",prompt,description,subagentType}`. `rawOutput` is a summary, for example shell `{exitCode,stdout,stderr}`, grep `{totalMatches,truncated}`, task `{durationMs,isBackground}` (`tool-call-presentation.ts`). **Diffs:** edit sends `content:[{type:"diff",path,oldText,newText}]`, using full before/after file text when available. Otherwise it reconstructs text from `diffString` hunks joined with `"\n...\n"`, which is lossy. Delete sends a diff with `newText:""`. **Shell output is not streamed** over ACP. The internal stream has `shellOutputDelta` and `editToolCallDelta`, but the ACP presenter only handles `textDelta`, `thinkingDelta`, `partialToolCall`, `toolCallStarted` and `toolCallCompleted`. Cursor runs tools itself and never calls client `fs/*` or `terminal/*` (grep count 0).

**Cursor extension requests (agent→client).** Despite the docs, these are all JSON-RPC requests sent via `connection.extMethod`, so they need a response. `types.ts` defines the names:

- `cursor/ask_question` (blocking): `{toolCallId,title?,questions[{id,prompt,options[{id,label}],allowMultiple}]}` returns `{outcome:{outcome:"answered",answers[{questionId,selectedOptionIds}]}|{outcome:"skipped",reason?}|{outcome:"cancelled"}}`.
- `cursor/create_plan` (blocking): `{toolCallId,name?,overview?,plan(md),todos[{id,content,status}],isProject?,phases?}` returns `{outcome:{outcome:"accepted",planUri?}|"rejected"(reason?)|"cancelled"}`.
- `cursor/update_todos`: `{toolCallId,todos[{id,content,status:pending|in_progress|completed|cancelled}],merge}`, sent after the `updateTodosToolCall` completes.
- `cursor/task`: `{toolCallId,description,prompt,subagentType,model?,agentId?,durationMs?}`, sent when the `Task` tool call completes.
- `cursor/generate_image`: `{toolCallId,description,filePath?,referenceImagePaths?}`.
- Client→agent: `cursor/list_available_models`.

These names have no `_` prefix, which violates ACP's rule that custom methods "start with an underscore" (`ACP:docs/protocol/v1/extensibility.mdx`). Strict SDK clients may need a raw handler.

### 3b. stream-json (headless)

Code: `B:9352/src/headless.ts`; docs: docs/cli/reference/output-format. All lines carry `session_id`, and most carry `timestamp_ms`.

- `system/init{apiKeySource,cwd,session_id,model(display name),permissionMode:"default"}`, then `user{message}`.
- `assistant{message.content[text]}`. By default it is emitted once per segment between tool calls. With `--stream-partial-output` it is emitted per delta. Dedup rules: deltas have `timestamp_ms` and no `model_call_id`. Skip lines with both fields (pre-tool flush) and lines with neither (final flush) (docs).
- `thinking{subtype:"delta",text}` and `thinking{subtype:"completed"}`. These appear in the code even though the docs say thinking is suppressed.
- `tool_call{subtype:"started"|"completed",call_id,model_call_id,tool_call:{<case>ToolCall:{args,result?}}}`. Optional `env` appears with the hidden `--printenv`.
- `interaction_query{subtype:"request"|"response",query_type,query|response}`. This shows auto-decided web search/fetch, questions and plans.
- `retry{subtype:"starting"|"resuming",attempt,…}` and `connection{subtype:"reconnecting"|"reconnected",attempt,endpoint_url?}`.
- `system{subtype:"task_notification",task_id,status,title,detail?}` (background work completed) and `system{subtype:"background_shell_timeout",aborted_count,timeout_ms}`.
- `result{subtype:"success",is_error:false,duration_ms,duration_api_ms,result,request_id,usage?:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}`. `inputTokens` excludes cache tokens and is summed across follow-up turns. **On failure there is no result line**: the process exits non-zero with the error on stderr (docs). After the first `result`, the loop keeps running follow-up turns for pending background completions or goal continuation **before** emitting the final `result` and exiting.

---

## 4. Subagents

- **They exist and run in parallel.** Built-in types include Explore, Bash/shell and Browser. Custom types live in `.cursor/agents/*.md` or `~/.cursor/agents/` with frontmatter `name, description, model, readonly, is_background`. Subagents can run in the foreground or background, can nest ("limited nesting depth"), and can be resumed by agent ID. They are supported in the CLI and Cloud (docs/subagents). The CLI changelog dates them to March 2026, with async/background support and full subagent transcripts added on Aug 11, 2026 (docs/cli/changelog). The `taskToolCall` args include `description, prompt, subagentType, model, agentId, resume` (`subagent-history.ts`, `session-update-presenter.ts`). The ACP `subagentType` enum is `unspecified|computer_use|explore|video_review|browser_use|shell|vm_setup_helper|{custom}`.
- **ACP with `clientCapabilities._meta.subagents = {}`** (`session-resources.ts` class `G`, `types.ts` `i7`):
  - `subagent_spawned{subagentSessionId,name,task,capabilities:{},_meta:{cursor:{toolCallId,agentId,model?}}}` is sent **on the parent's sessionId**. For nested children, the parent is the parent subagent's session (`resolveParentSession`). `toolCallId` is the parent's `Task` tool call, which gives us **explicit parent linkage**.
  - All of the child's text, thought and tool-call updates then arrive as normal `session/update` with `sessionId = subagentSessionId` (a per-child presenter).
  - `subagent_state_update{subagentSessionId,state,_meta}` reports terminal states only: `completed|failed|cancelled|disconnected`. A run that moves to the background sends nothing until it finishes. If a subagent is resumed after it terminated, it gets a **new** session id `"<agentId>.<n>"` (`startNewRun`).
  - The `session/prompt` response is held until all of the turn's subagents are terminal. Pending subagent completions are fed back as follow-up runs (`backgroundTaskCompletionAction`) (`subagent-completion-drain.ts`; `agent-session.ts` `finally`).
  - On cancel, child runs are aborted and Cursor waits up to **10 s** (`G=1e4`). Children still running are then marked `disconnected` (`whenAllTerminal`).
  - Subagent approvals: web search/fetch prompts go to the **child** sessionId. Shell, write and MCP approvals use the parent's decision store, so they arrive with the **parent** sessionId and the child's toolCallId **[unverified]**. `ask_question` and `switch_mode` inside subagents are auto-rejected ("Interactive questions are not supported in ACP subagent mode").
  - On `session/load`, history replays `subagent_spawned` + terminal `subagent_state_update` (`replayHistorical`), but **does not replay child transcripts**.
- **Without the capability**, subagents still run. The client only sees the parent's `Task` tool call (`kind:"other"`, title `"Task: <description>"`) and a `cursor/task` request at completion. The prompt can return `end_turn` while background subagents are still working. That is the t3code failure mode.
- **Spec drift.** ACP's unstable RFD defines `subagent_update{sessionId,title,description,capabilities{cancel},state:StateUpdate}` plus `session_message(_chunk)`, gated by top-level `clientCapabilities.subagents` (`ACP:docs/rfds/subagents.mdx`; `schema/v1/schema.unstable.json#SubagentUpdate`). Cursor implements an earlier shape and needs the `_meta` gate, because SDK 0.14.1's zod schema drops the unknown top-level key **[probe]**. Expect Cursor to migrate. Support both shapes.
- **stream-json** emits nothing about subagent internals, only the parent's `taskToolCall` started/completed. **Transcripts** keep each child in `agent-transcripts/<parentId>/subagents/<agentId>.jsonl` (local inspection). That is the only place to recover a child's history after the fact.

---

## 5. Status and liveness

| Signal                                                                                                       | Meaning                                                                                                                             | Caveat                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `session/prompt` result `{stopReason:"end_turn"}`                                                            | Turn finished, possibly **with an error rendered as text**                                                                          | Check the last agent text for `^\n\nError: ` and the known plan/auth messages (`agent-session.ts` catch) |
| `{stopReason:"cancelled"}`                                                                                   | Client `session/cancel`, **or a new `session/prompt` superseded it**                                                                | `max_tokens`/`refusal`/`max_turn_requests` are never returned                                            |
| JSON-RPC error on prompt                                                                                     | `Session … not found` or similar                                                                                                    |                                                                                                          |
| Outstanding agent→client request (`session/request_permission`, `cursor/ask_question`, `cursor/create_plan`) | Blocked on a human                                                                                                                  | No timeout found in Cursor's code. Waits for as long as the process lives **[unverified]**               |
| Children without a terminal `subagent_state_update`                                                          | Blocked on subagents (parent prompt still open)                                                                                     | Only with `_meta.subagents`                                                                              |
| Background shells (Ctrl+B-style, `AwaitShell`)                                                               | **Not surfaced over ACP.** The ACP drain only consumes `subagent` completions and re-queues others (`subagent-completion-drain.ts`) | Shell completions after `end_turn` are probably delivered on the next prompt **[unverified]**            |
| Network/rate limit                                                                                           | ACP: none (connection state goes to `debugLog` only). stream-json: `retry`, `connection`                                            | ACP needs silence-based `unresponsive` detection                                                         |
| Process exit / stdout EOF                                                                                    | Fatal                                                                                                                               | stderr may contain diagnostics                                                                           |

Cases where the response doesn't mean done: background subagents without the capability, background shells, async `session_info_update`, `cursor/update_todos`/`cursor/task` requests racing the tool completion, and children marked `disconnected` after the 10 s cancel cascade that may still be executing server-side **[unverified]**.

---

## 6. Human-in-the-loop

- **Permissions** (`session-resources.ts` class `T`). Cursor sends `session/request_permission{toolCall:{toolCallId,title,kind,status:"pending",content},options:[allow-once(allow_once), allow-always(allow_always), reject-once(reject_once)]}`. Covered operations: Write/edit (with diff content), Shell (with reason text), Delete, MCP (args JSON), web fetch and web search. No `reject_always` is offered. `allow-always` persists an allowlist entry `Shell(cmd)`, `Write(path)`, `Mcp(server:tool)`, `WebFetch(domain)` or `WebSearch(term)` into Cursor's permissions, which affects the user's TUI too. A `cancelled` outcome counts as a rejection. Permission syntax and config files: `~/.cursor/cli-config.json` and `<project>/.cursor/cli.json`, `permissions.allow/deny`, deny wins (docs/cli/reference/permissions). The local config also has `approvalMode: "allowlist"`, `sandbox`, `steering`, `autoAcceptWebSearch`.
- **Questions.** `cursor/ask_question` (multi-question, multi-select). If the method is missing (`-32601`), Cursor falls back to one permission prompt per **single-select** question. Options map to `allow_once`, plus a `Skip` option (`reject_once`). Multi-select questions are dropped (`ask-question-handler.ts`).
- **Plan review.** `cursor/create_plan`. Cursor first sends a `plan` update and a "Create Plan: <name>" tool card with progress text. On `accepted` without a `planUri`, it writes a plan file itself (observed under `~/.cursor/plans/*.plan.md`). If the client lacks the method, the plan is auto-accepted and saved (`create-plan-handler.ts`). This makes plan review a non-blocking UI unless ace implements the method.
- **Modes.** `agent` (CLI "default"), `plan` (read-only planning) and `ask` (Q&A, CLI "search"). Aliases `code/architect/chat` are accepted (`mapAcpModeToCliMode`). The agent can switch modes on its own through the `switchModeToolCall`, which ACP auto-approves.
- **MCP.** Servers come from `.cursor/mcp.json` or `~/.cursor/mcp.json` plus `session/new.mcpServers` (stdio/http/sse). Team dashboard MCP servers are not supported in ACP (docs/cli/acp). `mcpAuthRequestQuery` is rejected in CLI mode. Use `agent mcp login|list|list-tools|enable|disable` and `--approve-mcps` out-of-band.

---

## 7. Control

| Operation                                     | ACP                                                                   | Notes                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Cancel                                        | `session/cancel` (notification)                                       | Cascades to the turn's subagents (§4)                                                                                 |
| Steer / queue mid-turn                        | **None.** A second `session/prompt` cancels the first                 | TUI has steering (changelog Aug 11, 2026), not exposed over ACP. ace must queue client-side                           |
| Resume                                        | `session/load{sessionId,cwd,mcpServers}`                              | ACP-store sessions only. Replays history with synthetic tool ids `replay-<turn>-<step>` that won't match the live ids |
| List                                          | `session/list{cwd?}` returns `{sessionId,cwd,title,updatedAt}`        | No pagination (cursor param rejected). ACP sessions only                                                              |
| Set mode                                      | `session/set_mode` or `session/set_config_option{configId:"mode"}`    |                                                                                                                       |
| Set model                                     | `session/set_model` (unstable) or `set_config_option{configId:"model" | <param id>}`                                                                                                          | Process-global and persisted |
| Fork / resume-without-replay / close / delete | `-32601` **[probe]**                                                  |                                                                                                                       |
| New empty chat id                             | `agent create-chat` (CLI)                                             | For headless `--resume <id>`                                                                                          |

---

## 8. History

- **ACP sessions** live at `~/.cursor/acp-sessions/<uuid>/{meta.json{schemaVersion:1,cwd,title?},store.db}` (`acp-storage.ts`). `session/list` scans this directory and merges in live sessions.
- **TUI and headless chats** live at `~/.cursor/chats/<workspace-hash>/<chatId>/{meta.json{createdAtMs,updatedAtMs,hasConversation},store.db}`, browsable with `agent ls`, `agent resume`, `--resume [id]` and `--continue` (docs/cli/overview). Since July 6, 2026 the picker spans all workspaces (changelog). These chats **cannot** be loaded over ACP: `loadSession` resolves only `acp-sessions/<id>/store.db` and throws `Session "<id>" not found` otherwise (`agent-store.ts`).
- **Readable history** for ace import comes from the `agent-transcripts` JSONL (§1). Turn boundaries are `{"type":"turn_ended","status":"success"|"aborted"|"error"}`, and subagents get per-file transcripts. Tool results aren't present, so imported history shows calls without outputs.
- `agent persist` keeps TUI sessions alive across terminal disconnects (`agent help persist`). It is TUI-only and not relevant to ACP.

---

## 9. Extras

- **Images.** `promptCapabilities.image=true`; audio and embedded context are false **[probe]**. `resource_link` to a file inside the project root is inlined, truncated at 20,000 chars. `resource` blocks are inlined as text (`agent-session.ts`). Image generation surfaces as `generateImageToolCall` plus `cursor/generate_image`.
- **Rules and skills.** Cursor rules, `AGENTS.md`, skills (`~/.cursor/skills*`) and custom commands are loaded by the CLI. Skills and commands appear in `available_commands_update`, and `/name args` prompts are resolved by Cursor.
- **Usage.** ACP has none. stream-json has per-run token `usage`. The TUI has `/usage` plan meters (changelog July 13, 2026). The Cloud API has `GET /v1/agents/{id}/usage`.
- **Worktrees and sandbox.** `--worktree`, `--worktree-base`, `--sandbox enabled|disabled`.

---

## 10. Gaps, risks, adapter notes

**Risks**

1. Non-standard wire elements: `subagent_spawned`/`subagent_state_update` violate ACP's "no custom root fields" rule, and the `cursor/*` method names lack the `_` prefix (`ACP:docs/protocol/v1/extensibility.mdx`). An adapter built on the official TS SDK's zod parsing may reject or drop them. **Parse `session/update` leniently at the raw JSON-RPC layer.**
2. Errors arrive as plain text with `end_turn`, so ace needs a string classifier and must be careful: assistant prose can legitimately contain "Error:". Only classify a final chunk that starts with `\n\nError: ` and consists solely of the diagnostic.
3. There is no `failed` tool status. Derive failure from `rawOutput.error | rejected | permissionDenied | exitCode≠0`.
4. Model changes are process-global and persisted. Allow-always grants are written to the user's global Cursor config, so show that in the UI.
5. Docs/code drift and auto-update. Pin observed behavior to a version and keep fixtures.
6. The 10 s cancel cascade means `disconnected` children are not provably stopped.

**Adapter design**

- Spawn `agent [--api-key …] acp` with `cwd` set to the thread workspace. Call `initialize` with `clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false,_meta:{subagents:{},parameterizedModelPicker:true}}`. Check `agentCapabilities.sessionCapabilities.subagents`.
- Build the agent tree: root agent = ACP sessionId. On `subagent_spawned`, create a child agent with `parentId` = the agent owning the update's `sessionId`, `spawnToolCallId=_meta.cursor.toolCallId`, `providerAgentId=_meta.cursor.agentId`, `name`, `task`, `model`. Route all updates by `sessionId` to that agent's transcript. Support the RFD `subagent_update` too.
- Status derivation per agent:
  - root `working` while the prompt is outstanding;
  - `blocked{human}` while any agent→client request is open;
  - `blocked{subagents}` when the root has had no own updates since its last tool completed and some child is non-terminal;
  - `idle` on `end_turn` with no error and no non-terminal children;
  - `failed` on `end_turn` with a classified error;
  - `interrupted` on `cancelled`;
  - `unresponsive` after N seconds of silence with no open interaction;
  - children: `completed→idle(done)`, `failed→failed`, `cancelled→interrupted`, `disconnected→unresponsive`.
- Activity: `thinking` (thought chunk), `responding` (message chunk), `tool:<kind>` (tool in progress).
- Keep a client-side prompt queue. Never send a second `session/prompt` while one is open unless the user explicitly asked to interrupt.
- Preserve the raw data: store `kind`, `title`, `rawInput`, `rawOutput`, `content` and `locations` verbatim. Infer Cursor's tool case from `title` prefix plus `rawInput` shape (`_toolName` where present). Inference is brittle, so keep `custom` as the fallback. ACP's new optional tool-call `name` field (`ACP:docs/rfds/tool-call-name.mdx`) would fix this if Cursor adopts it.

---

## Mapping to ace canonical model

| ace concept                       | Cursor ACP source                                                                 | Notes                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Agent (root)                      | `session/new`/`load` sessionId                                                    |                                                              |
| Agent (sub), `parentId`           | `subagent_spawned` on parent sessionId; `_meta.cursor.{toolCallId,agentId,model}` | Requires `_meta.subagents`. Resumed runs get `<agentId>.<n>` |
| Agent transcript                  | `session/update` keyed by sessionId                                               | Child history isn't replayed on load. Use transcripts JSONL  |
| Status `working{activity}`        | prompt outstanding + last chunk/tool                                              |                                                              |
| `blocked{human}`                  | open `request_permission` / `cursor/ask_question` / `cursor/create_plan`          |                                                              |
| `blocked{subagents}`              | non-terminal children while prompt open                                           |                                                              |
| `blocked{background_task}`        | not exposed                                                                       | stream-json `task_notification` only                         |
| `blocked{rate_limit\|network}`    | not exposed                                                                       | stream-json `retry`/`connection`                             |
| `idle` / `interrupted` / `failed` | `end_turn` / `cancelled` / error text or process exit                             |                                                              |
| `unresponsive`                    | heuristic silence; child `disconnected`                                           |                                                              |
| Interaction: approval             | `session/request_permission`                                                      | options allow-once/allow-always/reject-once                  |
| Interaction: question             | `cursor/ask_question`                                                             | fallback via permission                                      |
| Interaction: plan review          | `cursor/create_plan` + `plan` update                                              | auto-accepted if unimplemented                               |
| Plan/todo update                  | `cursor/update_todos` (todos, merge)                                              | not ACP `plan`                                               |
| Thread title                      | `session_info_update.title`                                                       | async                                                        |
| Usage                             | none                                                                              | stream-json `result.usage`                                   |

**Tool mapping** (Cursor protobuf case → ACP `kind` per `types.ts` `DG` → ace kind):

| Cursor case                                                                                                                                                   | ACP kind                 | ace tool kind                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------- |
| `shellToolCall`, `writeShellStdinToolCall`                                                                                                                    | execute                  | `shell` (stdin: `shell` w/ subtype)                 |
| `readToolCall`                                                                                                                                                | read                     | `file.read`                                         |
| `editToolCall`, `applyAgentDiffToolCall`                                                                                                                      | edit                     | `file.edit` (`file.write` when diff `oldText` null) |
| `deleteToolCall`                                                                                                                                              | delete                   | `file.delete`                                       |
| (none)                                                                                                                                                        | —                        | `file.move`: not emitted                            |
| `grepToolCall`, `globToolCall`, `lsToolCall`, `semSearchToolCall`                                                                                             | search                   | `search`                                            |
| `webSearchToolCall`                                                                                                                                           | search                   | `web.search`                                        |
| `webFetchToolCall`, `fetchToolCall`                                                                                                                           | fetch                    | `web.fetch`                                         |
| `mcpToolCall`, `listMcpResourcesToolCall`, `readMcpResourceToolCall`                                                                                          | other/read               | `mcp`                                               |
| `taskToolCall` (no `resume`)                                                                                                                                  | other                    | `agent.spawn`                                       |
| `taskToolCall` with `resume`/`agentId`                                                                                                                        | other                    | `agent.message` **[unverified]**                    |
| `updateTodosToolCall`, `readTodosToolCall`                                                                                                                    | other/read               | `plan/todo update`                                  |
| `createPlanToolCall`                                                                                                                                          | other                    | `plan/todo update` + Interaction                    |
| `askQuestionToolCall`                                                                                                                                         | think                    | `ask_user`                                          |
| `generateImageToolCall`                                                                                                                                       | other                    | `image`                                             |
| `computerUseToolCall`, `recordScreenToolCall`                                                                                                                 | execute/other            | `browser` (computer use)                            |
| `switchModeToolCall`                                                                                                                                          | switch_mode              | `custom` (mode)                                     |
| `readLintsToolCall`, `reflectToolCall`, `setupVmEnvironmentToolCall`, `replaceEnvToolCall`, `startGrind*`, `reportBugfixResultsToolCall`, `truncatedToolCall` | read/think/execute/other | `custom`                                            |
| (none)                                                                                                                                                        | —                        | `notebook`: not emitted                             |

---

## ACP as a generic surface (for a generic ace ACP adapter)

**What v1 stable (schema-v1.24.1) can express.**

- Methods: `initialize`, `authenticate`, `logout`, `session/new|load|list|delete|resume|close|prompt|cancel|set_mode|set_config_option`; client methods `session/request_permission`, `session/update`, `fs/*`, `terminal/*`, `elicitation/create|complete`; `$/cancel_request` (`ACP:schema/v1/meta.json`).
- Update variants: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update{used,size,cost?}`.
- `StopReason`: `end_turn|max_tokens|max_turn_requests|refusal|cancelled`. `ToolKind`: `read|edit|delete|move|search|execute|think|fetch|switch_mode|other`. `ToolCallStatus`: `pending|in_progress|completed|failed`. Permission kinds: `allow_once|allow_always|reject_once|reject_always`. Tool content: `content|diff|terminal`. Config categories: `mode|model|model_config|thought_level` (`ACP:schema/v1/schema.json`).
- Cancellation: on cancel, the agent MUST answer the prompt with `cancelled`, and the client MUST answer pending permissions with `cancelled` (`ACP:docs/protocol/v1/prompt-turn.mdx`).
- Unstable additions: `subagent_update`, `session_message(_chunk)`, `plan_update/plan_removed`, `notice`, `compaction_update`, `session/fork`, `providers/*`, `mcp/message` (`ACP:schema/v1/schema.unstable.json`, `meta.unstable.json`).
- v2 (draft; behind `unstable_protocol_v2`): `session/prompt` returns only after the prompt is **inserted** (`{messageId}`), and lifecycle moves to `state_update{running|idle(stopReason)|requires_action}`. Tool calls become a single upsert, agent-owned terminals stream output, `cancelled` is added to tool/plan statuses, modes are removed in favour of config options, and enums become open (`_`-prefixed customs) (`ACP:docs/rfds/v2/overview.mdx`, `schema/v2/schema.json`).

**What it cannot express relative to ace's model (v1).**

- Subtree status. There is no agent tree in stable. The unstable `subagent_update` adds parent linkage and per-child `StateUpdate`, but no depth or spawning tool id: Cursor puts that in `_meta`.
- `blocked{background_task|rate_limit|network}`, `unresponsive`. v2 `requires_action` covers only `blocked{human}`.
- Background work after a turn ends. v1 ties everything to the prompt response.
- Typed tool identity. You get `kind` and title only, until the `name` RFD (`ACP:docs/rfds/tool-call-name.mdx`) is adopted. There are no kinds for MCP, agent.spawn/message, todo, ask_user, browser, image or notebook, and `rawInput`/`rawOutput` are agent-defined.
- Structured questions and plan review. These need either elicitation (form mode, if the agent uses it) or vendor extensions like `cursor/*`.
- Steering or queueing. Not in v1. Turn ordering and message identity: chunks have no ids in v1, while v2 requires `messageId`.

A generic adapter should therefore treat ACP as a transport for transcript plus approvals. Layer the status and tree derivation on top, with per-agent "quirk" modules (Cursor: `_meta.subagents`, `cursor/*`, text-errors, cancel-on-reprompt).

---

## Open questions / needs live verification

1. Do agent-initiated mode switches emit `current_mode_update`?
2. Are background-shell completions after `end_turn` delivered in ACP, and when (next prompt? never)?
3. For subagent shell/write approvals, confirm which `sessionId` the request carries, and whether parallel children can have concurrent pending permissions.
4. Does `disconnected` after the cancel cascade leave server-side work running, and is token spend still incurred?
5. Exact text of every error string family (quota, auth, network) for the classifier.
6. `cursor/list_available_models` and `set_config_option` payloads with the live model catalogue, and whether model changes rewrite `~/.cursor/cli-config.json`.
7. Is `taskToolCall.args.resume` used for "message existing subagent", and does it produce a `<agentId>.<n>` child session?
8. Long-running pending permission: any server-side timeout?
9. Whether Cursor will adopt RFD `subagent_update` and the tool-call `name` field, and with what gate.

---

## Sources

- Installed CLI 2026.09.26-dd393fe: `~/.local/share/cursor-agent/versions/2026.09.26-dd393fe/` (`index.js`; `5672.index.js` modules `src/acp/{run,cursor-acp-agent,agent-session,agent-store,acp-storage,config-store,session-list,session-resources,session-update-presenter,tool-call-presentation,subagent-completion-drain,subagent-history,types}.ts`, `src/acp/interaction-handlers/{ask-question,create-plan}-handler.ts`; `8096.index.js` (`@agentclientprotocol/sdk@0.14.1`); `9352.index.js` `src/headless.ts`; `3732.index.js` `src/utils/interaction-responses.ts`); `agent --help`, `agent help acp|persist|mcp|ls|status|about|worker|models`; ACP probe of `initialize`, `session/list`, `session/resume`, `session/fork`, `session/close`.
- Local state (shapes only): `~/.cursor/{acp-sessions,chats,projects/*/agent-transcripts,plans,cli-config.json}`.
- https://cursor.com/docs/cli/acp
- https://cursor.com/docs/cli/reference/output-format
- https://cursor.com/docs/cli/headless
- https://cursor.com/docs/cli/overview
- https://cursor.com/docs/cli/reference/permissions
- https://cursor.com/docs/cli/changelog
- https://cursor.com/docs/subagents
- https://cursor.com/docs/agent/hooks
- https://cursor.com/docs/cloud-agent/api/endpoints
- https://github.com/agentclientprotocol/agent-client-protocol (tag `schema-v1.24.1`): `schema/v1/{schema,schema.unstable,meta,meta.unstable}.json`, `schema/v2/{schema,meta}.json`, `docs/protocol/v1/{extensibility,prompt-turn,cancellation}.mdx`, `docs/rfds/{subagents,tool-call-name}.mdx`, `docs/rfds/v2/overview.mdx`
- https://agentclientprotocol.com/protocol/schema
- npm `@agentclientprotocol/sdk` latest = 1.6.0 (registry.npmjs.org, 2026-10-02)

## ace MCP injection

The ACP HTTP `mcpServers` shape and read-only discovery contract is recorded in
[ace MCP injection contracts](ace-mcp-injection.md#cursor-and-antigravity-via-acp).
