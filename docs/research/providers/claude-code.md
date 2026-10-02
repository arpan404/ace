# Claude Code / Claude Agent SDK: provider research for ace

Researched 2026-10-01/02. Versions inspected:

- `@anthropic-ai/claude-agent-sdk@0.3.287` (installed in `/tmp/research-claude`), which bundles the native Claude Code binary **2.1.287** (`manifest.json` `"version": "2.1.287"`, `buildDate 2026-10-01`).
- Local CLI: Claude Code **2.1.286** at `~/.local/bin/claude` (`claude --version`).

Citation shorthand:

- `d.ts:N` = `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` line N (SDK 0.3.287).
- `tools.d.ts:N` = `sdk-tools.d.ts` in the same package.
- `docs/<page>` = `https://code.claude.com/docs/en/<page>`, fetched 2026-10-01.
- **[unverified]** marks claims taken from types or docs that have not been checked against a live session.

---

## TL;DR

**Recommendation:** use the **TypeScript Agent SDK (`query()` in streaming-input mode)** as the only live integration surface. Run one long-lived `Query` per ace thread. Use **on-disk JSONL plus the SDK session helpers** (`listSessions`, `getSessionMessages`, `getSubagentMessages`) as the secondary surface, for history import and crash recovery. Don't build on hooks-as-shell-commands, OTel, or raw stream-json. The SDK already wraps stream-json and gives you in-process hooks and `canUseTool`.

Key facts:

1. **`result` is a turn boundary, not "done".** The SDK says so itself: system messages (task notifications, `session_state_changed`, prompt suggestions) "may still follow it" (d.ts:5721). Background Bash, Monitor watches and background subagents survive the result. Their completion arrives later as `system/task_notification`, which **starts a new turn** whose user message has `origin.kind === "task-notification"` (docs/agent-sdk/typescript § SDKTaskNotificationMessage). The authoritative signal is `system/session_state_changed{state:'idle'}`: it "fires after heldBackResult flushes and the bg-agent do-while exits — authoritative turn-over signal" (d.ts:5851-5857). Combine it with the `background_tasks_changed` level set (d.ts:3703-3722).
2. **Subagent activity is fully observable.** `task_started` carries `task_id`, `tool_use_id`, `task_type` (`local_agent` | `local_bash` | `remote_agent` | `local_workflow`…), `is_backgrounded` and `spawn_depth` (d.ts:6040-6074). Every subagent frame carries `parent_tool_use_id` = the spawning `Agent` tool_use id (d.ts:3615). Set `forwardSubagentText: true` (d.ts:1867) to get subagent text and thinking as well, not only tool calls, at every nesting depth (docs/headless § Follow subagent messages).
3. **Approvals can wait forever.** `canUseTool` "can stay pending indefinitely" (docs/agent-sdk/user-input). Permission prompts "have no park deadline" (d.ts:207-212), so cross-device resolution works as long as the process lives. For approvals that must outlive the process, a `PreToolUse` hook can return `defer`. That only works in `-p`/SDK mode and only when the turn made a single tool call (docs/hooks § Defer a tool call for later).
4. **Process model.** The SDK spawns the bundled native `claude` binary with `--output-format stream-json --verbose --input-format stream-json` (sdk.mjs, spawn-args literal). That means one OS process per `Query`. Override with `pathToClaudeCodeExecutable` (d.ts:1977) or `spawnClaudeCodeProcess` (d.ts:2442). `prewarm()`/`startup()` hide spawn latency (d.ts:2823, 9517).
5. **Auth caveat.** Docs: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" (docs/agent-sdk/overview). The SDK still technically uses whatever credential the CLI finds (precedence ends at `/login` subscription OAuth; docs/authentication § Authentication precedence). ace should treat "use the user's own local Claude login" as a product and legal decision, not a technical one.
6. **Tool names are stable strings with raw input.** Every `tool_use` block keeps `name` and `input`. Structured outputs arrive in `SDKUserMessage.tool_use_result` (d.ts:6225-6227), with per-tool shapes in `sdk-tools.d.ts`. `Agent` is listed as `Task` in `system/init.tools` and older transcripts use `Task`, so match both (docs/agent-sdk/subagents § Detect subagent invocation).
7. **The protocol churns very fast** (SDK patch 0.3.287 ≈ CLI 2.1.287). Use `system/init.capabilities` for feature detection (d.ts:5970-5972), and ignore unknown message types and subtypes. The SDK explicitly says the set grows (d.ts:5323-5326).

---

## 1. Integration surfaces

| Surface                                                                                                          | What it gives                                                                                                                                                                                                                                                                                    | Verdict                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent SDK TS** (`query()`)                                                                                     | Typed stream of `SDKMessage` (39 variants, d.ts:5326). Control methods (`interrupt`, `setModel`, `setPermissionMode`, `stopTask`, `backgroundTasks`, `rewindFiles`, MCP toggles…; d.ts:2844-3242). In-process `canUseTool`, `hooks`, `onElicitation`, `onUserDialog` callbacks. Session helpers. | **Primary.**                                                                                                                                                             |
| CLI `-p --output-format stream-json --input-format stream-json`                                                  | The same wire protocol. The SDK is a thin wrapper that adds the control_request/control_response protocol (`StdoutMessage` = SDKMessage + control frames + `keep_alive`; d.ts:9520-9522).                                                                                                        | Use only if ace's daemon must be non-JS. You would have to re-implement the control protocol (`can_use_tool`, `hook_callback`, `initialize`…; d.ts:4977-4986).           |
| Hooks (settings.json command or HTTP hooks)                                                                      | 33 events (d.ts:957), including `SubagentStart`/`SubagentStop`, `Stop` (with `background_tasks`), `Notification`, `PermissionRequest`.                                                                                                                                                           | Use **in-process SDK hooks** (`Options.hooks`, d.ts:1728) for enrichment. Don't rely on user settings hooks: they're user-configurable and get skipped in `--bare` mode. |
| On-disk JSONL `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` plus `<sessionId>/subagents/agent-<id>.jsonl` | Full history, including subagent sidechains (docs/sub-agents § Resume subagents; d.ts:1143-1144).                                                                                                                                                                                                | **Secondary.** Use it for import and resume. Read through the SDK helpers rather than parsing it yourself (§8).                                                          |
| OTel (`CLAUDE_CODE_ENABLE_TELEMETRY=1`)                                                                          | Metrics plus events: tool_result, api_request, tool_decision, compaction, "subagent completed", hook execution; traces (beta) (docs/monitoring-usage § Events).                                                                                                                                  | Optional ops telemetry only. Not a UI data source.                                                                                                                       |
| MCP                                                                                                              | ace can inject its own in-process tools (`createSdkMcpServer`, d.ts:613) or route permission prompts through an MCP tool (`permissionPromptToolName`, d.ts:2009).                                                                                                                                | Use it for ace-specific tools such as a "notify user" tool. Not needed for observation.                                                                                  |

---

## 2. Launch, auth and process model

- **Spawn.** The SDK resolves a platform optional dependency (`@anthropic-ai/claude-agent-sdk-darwin-arm64` etc., package.json `optionalDependencies`) holding a native binary of about 228 MB (manifest.json). It always passes `--output-format stream-json --verbose --input-format stream-json` (sdk.mjs). ace can pin to the bundled binary, which gives a reproducible CLI version, or use the user's installed `claude` via `pathToClaudeCodeExecutable` (d.ts:1977). On musl or when bundling with `bun build --compile`, the binary must be extracted and passed explicitly (README "Compiled binaries").
- **One process per Query**, and it stays alive for the whole streaming-input session. A parked spare costs about 230-260 MB (d.ts:2769). `close()` kills the process (d.ts:3241). The abort signal handed to custom spawners only fires after stdin EOF plus a grace period of about 2 s (d.ts:9480-9500).
- **Environment.** `env` **replaces** `process.env` entirely (d.ts:1643-1660). Spread `process.env` yourself. Set `CLAUDE_AGENT_SDK_CLIENT_APP=ace/x.y` for the User-Agent. The entrypoint is recorded as `sdk-ts` (sdk.mjs sets `CLAUDE_CODE_ENTRYPOINT="sdk-ts"`; also seen in local transcripts: `entrypoint: "sdk-ts"`).
- **Settings.** `settingSources` omitted means user, project and local are all loaded. `[]` means isolation mode. `'project'` must be present for CLAUDE.md to load (d.ts:2240-2250). Also available: `settings` (flag layer, d.ts:2210), `managedSettings` (d.ts:2239), `projectConfigRoot` for worktrees (d.ts:1530-1539).
- **cwd and directories.** `cwd` (d.ts:1596) and `additionalDirectories` (d.ts:1529).
- **Auth.** Precedence: Bedrock/Vertex/Foundry env, then `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), profiles, and finally `/login` subscription OAuth (docs/authentication § Authentication precedence). `CLAUDE_CONFIG_DIR` isolates credentials and history per account (docs/authentication). `--bare` never reads OAuth or the keychain (`claude --help`).
  - `system/init.apiKeySource` reports the source; `'none'` means OAuth/subscription (d.ts:5906-5908).
  - `accountInfo()` returns email, organization, `subscriptionType` and `apiProvider` (d.ts:23-33, 3118).
  - `auth_status` messages stream login progress (d.ts:3693-3700).
  - Policy caveat: see TL;DR #5.
- **Version gating.**
  - `system/init.claude_code_version` (d.ts:5911) and `capabilities[]` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `queued_notifications`…; d.ts:5970).
  - Startup failures produce a zeroed `error_during_execution` result with `startup_failure_reason` (`cli_version_too_old`, `cwd_unavailable`, `session_held_by_background`…; d.ts:5692-5695, 5882).
  - Many fields are documented as "absent on older CLIs". Treat every non-core field as optional.

---

## 3. Event stream

All frames carry `uuid` and `session_id`. Discriminate on `type`, then on `subtype`.

**Core conversation**

- `system/init` (d.ts:5901-5983) is emitted **at the start of each turn**. It carries `model`, `cwd`, `tools[]`, `mcp_servers[{name,status,source}]`, `permissionMode`, `slash_commands`, `skills`, `agents`, `plugins`, `plugin_errors`, `effort`, `capabilities`, `claude_code_version`.
- `assistant` (d.ts:3606-3689). `message` is an Anthropic `BetaMessage`. The CLI emits **one assistant frame per completed content block**: frames share `message.id`, `stop_reason` is null, and usage is not final. Fields:
  - `parent_tool_use_id` (subagent attribution).
  - `error` (`rate_limit` | `overloaded` | `authentication_failed` | `billing_error` | `max_output_tokens` …; d.ts:3691).
  - `aborted: true` on interrupt.
  - `subagent_type` and `task_description`.
  - `supersedes[]` (refusal-fallback eviction).
  - `user_message_uuid(s)`, which binds the reply to ace's send.
- `user` (d.ts:6213-6303). In the outbound direction this is the prompt. Inbound it's tool_result blocks, plus `tool_use_result` (structured tool output), `origin` (human / peer / task-notification / coordinator / observer …, d.ts:5331-5387), `isSynthetic` and `priority`.
- `user` replay (`isReplay: true`, d.ts:6305-6377) echoes ace's own sends. CLI flag `--replay-user-messages`; **[unverified]** whether the SDK enables it.
- `result` (d.ts:5664-5802), with subtypes `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd` and `error_max_structured_output_retries`. Fields:
  - `is_error`, `num_turns`, `stop_reason`.
  - `terminal_reason` (`completed`, `aborted_streaming`, `aborted_tools`, `tool_deferred`, `background_requested`, `max_turns`, `budget_exhausted`, `blocking_limit`, `prompt_too_long`…; d.ts:9673).
  - `total_cost_usd` and `modelUsage` are cumulative per `query()`; read the latest, don't sum (d.ts:5673-5683).
  - `usage` is main-loop only.
  - `permission_denials[]`, `queued_turn_count`, `deferred_tool_use`, `structured_output`, `result_index` (a gap means a lost result; d.ts:5710).

**Partial streaming** (`includePartialMessages: true`, d.ts:1860)

- `stream_event` wraps one raw `BetaRawMessageStreamEvent`: `message_start`, `content_block_start`, `content_block_delta` (text_delta / thinking_delta / input_json_delta), `content_block_stop`, `message_delta`, `message_stop`. It also carries `parent_tool_use_id` and `ttft_ms` (d.ts:5473-5499). The complete `assistant` frame still follows.
- `system/thinking_tokens` gives a running estimate during redacted thinking (d.ts:6095-6109).
- Thinking display can be `summarized` | `omitted` (d.ts:9678-9703).

**Tool lifecycle**

- `tool_use` block (assistant), then optionally `canUseTool` / `system/permission_denied`, then `tool_progress{tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds, task_id?, heartbeat?, subagent_retry?}` (d.ts:6111-6130), then `tool_result` block (user) with `tool_use_result`.
- `tool_use_summary{summary, preceding_tool_use_ids}` (d.ts:6132-6139).
- **Detached calls:** a WebFetch/WebSearch that "stepped aside" returns `{detachedToolCall:true}`, and its real result comes in a later turn (d.ts:6225).
- **Backgrounded MCP calls:** the tool_result is a placeholder, and the real result arrives in `task_notification.resource_links`/summary, joined by `tool_use_id` (d.ts:6003; docs/agent-sdk/typescript).

**Todos and plans**

- `TodoWrite{todos[{content,status,activeForm}]}` (tools.d.ts:1081-1090).
- On current models the **Task\* tools** replace it: `TaskCreate{subject,description,activeForm,metadata}` and `TaskUpdate{taskId,status,addBlocks,addBlockedBy,owner…}` (tools.d.ts:2781-2846).
- Task tools are only present by default on older models (Claude 3.x, Opus 4–4.7, Sonnet 4–4.6, Haiku 4.5). On newer models **neither is present** unless you opt in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` or by listing the tools in `allowedTools`/`tools` (docs/tools-reference § Task tool availability).
- Plan mode: `EnterPlanMode{}` / `ExitPlanMode{}`. The model writes the plan to a file, and hooks see an injected `plan` and `planFilePath` (docs/hooks § ExitPlanMode). **[unverified]** whether `canUseTool` gets the injected plan or an empty input; verify live.

**Usage, context and compaction**

- Per-step usage is on `assistant.message.usage`; dedupe by `message.id` (docs/agent-sdk/cost-tracking). Per-model usage is `ModelUsage{inputTokens, outputTokens, cache*, costUSD, contextWindow, maxOutputTokens}` (d.ts:1430-1455).
- `getContextUsage({detail})` gives a category breakdown and `percentage` (d.ts:3034, 3777-3838).
- `system/status{status:'compacting'|'requesting'|null, permissionMode?, compact_result?}` (d.ts:5884-5896).
- `system/compact_boundary{compact_metadata{trigger, pre_tokens, post_tokens, preserved_messages}}` (d.ts:3737-3772).
- `PreCompact`/`PostCompact` hooks; PostCompact includes `compact_summary` (d.ts:2561-2568, 2685).

**Rate limits and errors**

- `rate_limit_event{rate_limit_info{status: allowed|allowed_warning|rejected, resetsAt, rateLimitType: five_hour|seven_day…, utilization, overage*}}` (d.ts:5627-5662).
- `system/api_retry{attempt, max_retries, retry_delay_ms, error_status, error}` (d.ts:3587-3604; docs/headless § Handle API retries).
- `usage_EXPERIMENTAL…()` returns plan windows (d.ts:3054).
- Exported string prefixes classify usage-limit text (d.ts:9799-9817).

**Other frames worth handling**

- `system/session_state_changed{idle|running|requires_action}` (d.ts:5853).
- `system/task_started|task_progress|task_updated|task_notification|background_tasks_changed` (§4, §5).
- `system/hook_started|hook_progress|hook_response` (with `includeHookEvents`, d.ts:1855; d.ts:5195-5231).
- `system/notification` (d.ts:5461), `system/informational` (d.ts:5236), `system/local_command_output` (d.ts:5266), `system/commands_changed` (d.ts:3729).
- `system/permission_denied` (d.ts:5510), `system/elicitation_complete` (d.ts:5146), `system/memory_recall` (d.ts:5301), `system/model_refusal_fallback|model_refusal_no_fallback` (d.ts:5408-5456).
- `conversation_reset` (/clear or plan-exit-with-clear; d.ts:5118-5135), `prompt_suggestion` (d.ts:5617), `system/files_persisted`, `system/mirror_error`, `system/plugin_install`, `system/worker_shutting_down`, `system/control_request_progress`.
- `keep_alive` is internal and should be ignored (d.ts:5257).

---

## 4. Subagents

- **Spawning.** Tool `Agent` (alias `Task`). Input: `{description, prompt, subagent_type?, model?, run_in_background?, name?, isolation?: 'worktree'|'remote'}` (tools.d.ts:763-800).
- **Agent output** (`tool_use_result`), tools.d.ts:100-205, is one of:
  - `status:'completed'` with `agentId`, content, usage, `toolStats`, `totalDurationMs`;
  - `status:'async_launched'` with `agentId` and `outputFile` (background);
  - `status:'remote_launched'` with `taskId` and `sessionUrl`.

  Local transcripts confirm `async_launched` with keys `agentId, canReadOutputFile, description, isAsync, outputFile, prompt, resolvedModel, status`.

- **Live attribution.**
  - Every subagent `assistant`/`user`/`stream_event`/`tool_progress` frame carries `parent_tool_use_id` = the `Agent` tool_use id that spawned it. Nested subagents carry _their_ spawner's id, so following the ids rebuilds the tree (docs/headless § Follow subagent messages; nested forwarding needs CLI ≥2.1.219).
  - The first subagent frame is a `user` message carrying its prompt.
  - By default only tool_use and tool_result blocks are forwarded. `forwardSubagentText: true` adds text and thinking (d.ts:1861-1867).
- **Task events.** `task_started` provides `task_id`, `tool_use_id`, `subagent_type`, `is_backgrounded`, `spawn_depth` (1 = spawned by main), `task_type`, `prompt` and `ambient` (d.ts:6040-6074). Then:
  - `task_progress` (`usage`, `last_tool_name`, optional `summary` when `agentProgressSummaries: true`; d.ts:6015-6038, 2072-2080);
  - `task_updated.patch{status: pending|running|completed|failed|killed|paused, is_backgrounded, error, end_time}` (d.ts:6076-6093);
  - `task_notification{status: completed|failed|stopped, summary, output_file, usage, reason?:'worker_restart'}` (d.ts:5985-6013).

  Resumed subagents always report `is_backgrounded: true`, and a resumed run "shows as running again" (docs/sub-agents § Resume subagents).

- **Ids.** `canUseTool` gets `agentID` (d.ts:278-279). Hooks get `agent_id` and `agent_type` (d.ts:180-187). `SubagentStart{agent_id, agent_type}` and `SubagentStop{agent_id, agent_transcript_path, last_assistant_message, background_tasks}` (d.ts:9561-9597). **[unverified]** The relationship between `task_id` and `agentId` (local transcripts suggest the same `a…` hex form) needs live confirmation. Join on `tool_use_id`, which all of them carry.
- **Foreground vs background.**
  - In SDK/`-p`, fork mode is off. Claude backgrounds by default and foregrounds when it needs the result (docs/sub-agents § Run subagents in foreground or background).
  - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` forces foreground.
  - `Query.backgroundTasks(toolUseId?)` = Ctrl+B (d.ts:3218-3232).
  - Background subagents surface permission prompts in the main session (CLI ≥2.1.186; docs/tools-reference § Agent tool behavior).
- **Limits.** Depth defaults to 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). Concurrency defaults to 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). `maxBudgetUsd` also stops background subagents (docs/agent-sdk/subagents § Cap subagent depth, concurrency, and spend).
- **Messaging.**
  - `SendMessage{to: agentId|name}` resumes a completed or stopped subagent in the background (docs/sub-agents § Resume subagents).
  - `TaskStop{task_id}` (tools.d.ts:969).
  - `Query.stopTask(taskId)` (d.ts:3217); a user-stopped subagent does not auto-resume.
  - The SDK can't address a subagent directly with user input. **[unverified]** `priority` on `SDKUserMessage` is not documented for routing.
- **Agent teams.** Experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Teammates **are not spawned in `-p`/Agent SDK sessions**; a named subagent runs as an ordinary subagent there (docs/agent-teams § Enable agent teams). The `TeammateIdle`/`TaskCreated`/`TaskCompleted` hooks exist (d.ts:9637-9671) but are mostly irrelevant to ace. Cross-session messaging arrives as `origin.kind:'peer'` (d.ts:5337-5364).
- **On disk.**
  - Layout: `<project>/<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json`. Local meta keys: `agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive`.
  - Subagent entries have `isSidechain: true` and `agentId`.
  - `getSubagentMessages(sessionId, agentId)` returns `SessionMessage{parent_tool_use_id, parent_agent_id}` (d.ts:937, 6437-6450). `listSubagents()` (d.ts:1150).
  - Subagent transcripts survive main-thread compaction and are swept after `cleanupPeriodDays` (30 days by default; docs/sub-agents).

---

## 5. Status and liveness ("result ≠ done")

Cases where `result` arrives while work continues:

1. **Background Bash** (`run_in_background`, or a foreground command auto-moved to the background at its timeout). It runs for up to 30 min by default and 2 h max (docs/tools-reference § Background commands). Completion produces `task_notification` and a **new turn** (`origin.kind:'task-notification'`). Output can be read with `get_task_output` (last 8 KiB; d.ts:4205-4230). **[unverified]** That control request isn't exposed as a `Query` method in 0.3.287.
2. **Monitor** watches: each stdout line or WebSocket frame becomes an event that wakes the model. Default 5 min, max 30 min (tools.d.ts:2950-2970).
3. **Background subagents and workflows.** Results come as a completion notification in a later turn (docs/sub-agents). In `-p` one-shot mode the CLI _holds_ the result until background agents finish (10-minute idle ceiling `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`), and background shells are killed about 5 s after the result (docs/headless § Background tasks at exit). In streaming-input SDK mode the process stays alive.
4. **Scheduled wakeups**: `CronCreate`, `ScheduleWakeup`, `/loop`. They appear in `StopHookInput.session_crons` (d.ts:9534-9553).
5. **Queued user sends**: `result.queued_turn_count > 0` means more turns follow (d.ts:5786-5789).
6. **Pending approvals or questions**: `session_state_changed: 'requires_action'` (d.ts:5856) and outstanding `canUseTool` promises.
7. **API retry or rate-limit wait**: `api_retry`, `rate_limit_event.status:'rejected'`, `assistant.error`.

**Idle detection algorithm (proposed):**

- agent `idle` ⇔ last `session_state_changed.state === 'idle'`
- ∧ the non-ambient set from `background_tasks_changed` is empty (`ambient` tasks are excluded per d.ts:3716)
- ∧ no pending `canUseTool`/elicitation/dialog
- ∧ `queued_turn_count === 0`.

Keep `session_crons` as a "scheduled wake" decoration, not as working. Reset the background set to empty on process (re)start. `reinitialize()` re-sends a snapshot and re-delivers pending `can_use_tool` requests (d.ts:2974-2999; docs/agent-sdk/typescript § SDKBackgroundTasksChangedMessage). **[unverified]** whether `session_state_changed` is emitted to plain SDK consumers by default (t3code handles it, which suggests yes). Verify live.

Hooks as a backstop:

- `Stop` gets `background_tasks[]` "to distinguish 'session is done' from 'paused waiting for background work'" (d.ts:9534-9553).
- `StopFailure{error}` (d.ts:9527).
- `Notification` types `permission_prompt`, `idle_prompt` and `agent_needs_input`. `permission_prompt` fires about 6 s after a `canUseTool` ask (docs/hooks § Notification).

Process death: watch the `SpawnedProcess` exit. `task_notification.reason:'worker_restart'` marks orphaned tasks (d.ts:5991-5994).

---

## 6. Human-in-the-loop

- **`canUseTool(toolName, input, opts)`** (d.ts:203-301).
  - `opts`: `signal`, `suggestions: PermissionUpdate[]`, `blockedPath`, `decisionReason`, `title` ("Claude wants to read foo.txt"), `displayName`, `description`, `defaultToNo`, `suppressAlwaysAllowRule`, `toolUseID`, `agentID`, `requestId`, `mcpServer{name,source}`, `matchedAskRule`.
  - The wire request adds `decision_reason_type` (`rule|mode|classifier|safetyCheck|…`), `classifier_approvable` and `requires_user_interaction` (d.ts:4781-4830).
  - Return `{behavior:'allow', updatedInput?, updatedPermissions?, decisionClassification?}` or `{behavior:'deny', message, interrupt?}` (d.ts:2505-2517).
  - `PermissionUpdate` covers addRules, replaceRules, removeRules, setMode, addDirectories and removeDirectories, with a destination of userSettings, projectSettings, localSettings, session or cliArg (d.ts:2524-2553).
  - Returning `null` means "answered out-of-band" and fails closed (d.ts:207-212).
  - The callback **never fires for auto-approved tools**. Use `PreToolUse` for audit-everything (docs/agent-sdk/user-input).
  - Evaluation order: hooks → deny → ask → mode → allow → canUseTool (docs/agent-sdk/permissions § How permissions are evaluated).
- **Permission modes:** `default | acceptEdits | bypassPermissions | plan | dontAsk | auto` (d.ts:2482).
  - When `permissionMode` is omitted, the SDK may start in **`auto`** (classifier). Pass `'default'` explicitly to get prompts (d.ts:1979-1991).
  - `bypassPermissions` requires `allowDangerouslySkipPermissions` (d.ts:2004).
  - `permissionPrompts:'none'` auto-denies (d.ts:2018).
  - The CLI help lists a `manual` mode that is not in the SDK type, a sign of churn.
- **AskUserQuestion** goes through `canUseTool`. Input `questions[1-4]{question, header(≤12 chars), options[2-4]{label, description, preview?}, multiSelect}` (tools.d.ts:1115+). The answer is `allow` with `updatedInput = {questions, answers: {[questionText]: label | label[]}, response?}` (docs/agent-sdk/user-input § Response format). `toolConfig.askUserQuestion.previewFormat:'html'` is available for web UIs (d.ts:1714-1730). Not available inside subagents (docs/agent-sdk/user-input § Limitations).
- **ExitPlanMode** goes through `canUseTool` (it requires permission; docs/tools-reference). Hooks see `plan` and `planFilePath` injected (docs/hooks § ExitPlanMode). Approving should be followed by `setPermissionMode(...)` as appropriate. **[unverified]** the exact plan-approval round-trip for SDK hosts.
- **MCP elicitation:** `onElicitation(request{serverName, message, mode: form|url, url?, elicitationId?, requestedSchema?})` returns an `ElicitResult` (d.ts:716-741, 1483-1491). Without the callback, requests are auto-declined (d.ts:1734-1735). Completion of URL mode arrives as `system/elicitation_complete`.
- **`onUserDialog`** for `request_user_dialog` (e.g. `refusal_fallback_prompt`). Only emitted for kinds declared in `supportedDialogKinds` (d.ts:1750-1785, 9825-9850).
- **Pending across devices.** There's no timeout on permission prompts (d.ts:211; docs/tools-reference: "permission prompts, including plan approval, never auto-resolve on idle"). AskUserQuestion only times out if the user setting `askUserQuestionTimeout` is set. An interrupt makes the CLI send `control_cancel_request` for pending asks (d.ts:3882-3891). The callback's `signal` aborts, and ace must then close the Interaction as `cancelled`.

---

## 7. Control

| Need                      | API                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupt turn            | `interrupt()` returns `{still_queued[], cancelled?[]}` on capable CLIs (d.ts:2858, 4597-4631). Without `perTaskStopAffordance: true`, an interrupt **kills background tasks**; with it, the interrupt spares them and ace must offer per-task stop (d.ts:1786-1805). Recommended: set it to true and expose `stopTask`.                                                      |
| Steer or queue mid-turn   | Keep writing `SDKUserMessage`s to the input iterable or `streamInput()` (d.ts:3212). Queued sends coalesce or fold into the running turn between tool rounds (`user_message_uuids`, d.ts:3626). Cancel a queued send with control `cancel_async_message` (d.ts:3877-3880; **[unverified]** not a `Query` method). Set `uuid` on every send for correlation. `priority: 'now' | 'next' | 'later'`(d.ts:6228) is undocumented **[unverified]**.`shouldQuery:false` appends without a turn (d.ts:6260). |
| Resume / continue / fork  | Options `resume`, `continue`, `forkSession`, `sessionId`, `resumeSessionAt` and `resumeDropsTurn` (d.ts:1589-1592, 1704-1707, 2082-2150). Function `forkSession(id, {upToMessageId})` (d.ts:836).                                                                                                                                                                            |
| Rewind files              | `enableFileCheckpointing` + `rewindFiles(userMessageId, {dryRun})` (d.ts:1691, 3127). Only Write, Edit and NotebookEdit are tracked. Bash changes and **subagent edits** are not (docs/agent-sdk/file-checkpointing).                                                                                                                                                        |
| Model / thinking / effort | `setModel` (d.ts:2894), `setMaxThinkingTokens` (deprecated, d.ts:2921), `applyFlagSettings({effortLevel, model,…})` (d.ts:2949), options `thinking`, `effort` and `fallbackModel` (d.ts:1904-1911, 1682).                                                                                                                                                                    |
| Permission mode           | `setPermissionMode` (d.ts:2865).                                                                                                                                                                                                                                                                                                                                             |
| MCP at runtime            | `mcpServerStatus`, `toggleMcpServer`, `reconnectMcpServer`, `setMcpServers` (d.ts:3023, 3155-3205).                                                                                                                                                                                                                                                                          |
| Background control        | `backgroundTasks(toolUseId?)` and `stopTask(taskId)` (d.ts:3217-3232).                                                                                                                                                                                                                                                                                                       |
| Reconnect                 | `reinitialize()` re-delivers pending prompts and dialogs; callbacks must be idempotent per `requestId` (d.ts:2974-2999).                                                                                                                                                                                                                                                     |
| Spend and turn caps       | `maxTurns`, `maxBudgetUsd`, `taskBudget` (d.ts:1925-1940).                                                                                                                                                                                                                                                                                                                   |

---

## 8. History

- **SDK functions** (root entry only, not `/core`; README):
  - `listSessions({dir, limit, offset, includeWorktrees, includeProgrammatic})` returns `SDKSessionInfo{sessionId, summary, lastModified, customTitle, firstPrompt, gitBranch, cwd, tag, createdAt}` (d.ts:1095-1138, 5807-5848).
  - `getSessionInfo` (d.ts:870).
  - `getSessionMessages(id, {includeSystemMessages, limit, offset})` builds the chain from `parentUuid` (d.ts:900-924).
  - `listSubagents` and `getSubagentMessages` (d.ts:937, 1150).
  - `renameSession`, `tagSession`, `deleteSession`, `forkSession`.
  - Alpha `SessionStore` for mirroring transcripts to ace's DB (`sessionStore`, `importSessionToStore`; d.ts:998, 1827).
- **JSONL schema** (observed locally, CLI 2.1.25x–2.1.286; structure only).
  - Entry types: `user`, `assistant`, `system`, `attachment`, `queue-operation` (enqueue/dequeue/remove), `last-prompt`, `ai-title`, `mode`, `permission-mode`, `file-history-snapshot`/`file-history-delta`, `cost-state`, `pr-link`, `bridge-session`, `atis-latch`.
  - Message entries carry `uuid`, `parentUuid`, `isSidechain`, `sessionId`, `cwd`, `gitBranch`, `version`, `entrypoint` (`cli` | `sdk-ts`), `promptId` and `timestamp`. Assistant entries add `requestId`; user entries add `toolUseResult`, `origin` and `sourceToolUseID`.
  - Observed `system` subtypes: `stop_hook_summary`, `turn_duration`, `api_error`, `compact_boundary`, `away_summary`, `informational`, `local_command`.
  - Observed origins: `human`, `task-notification`, `peer`.
  - The format is **undocumented and private**. Use the SDK readers and treat raw parsing as best-effort.
- **Importing existing sessions.** `listSessions()` without `dir` spans all projects. Resume works by id across project directories (CLI ≥2.1.223; docs/agent-sdk/sessions § Resume across hosts). `session_held_by_background` blocks resume of a session that is running as a `claude --bg` background session (d.ts:5880).

---

## 9. Extras

- **Images and attachments:** `SDKUserMessage.message.content` with image and document blocks (d.ts:6219-6221; docs/agent-sdk/streaming-vs-single-mode). `pasted_content`/`inline_pastes` (d.ts:6285-6292). `verbatimPrompts`/`client_composed` disables `@path` and slash expansion (d.ts:1868-1891).
- **Slash commands and skills:** `supportedCommands()` returns `SlashCommand{name, description, argumentHint, aliases, builtin}` (d.ts:3005, 9314-9340). `system/commands_changed` pushes replacements. `init.terminal_slash_commands` lists commands to hide on remote UIs (d.ts:5929-5931). Commands are sent as prompt text such as `/compact`. Other helpers: `skills` option (d.ts:2273), `reloadSkills`/`reloadPlugins`, `supportedAgents()`, `supportedModels()` (returns `ModelInfo` with effort and fast-mode support; d.ts:1389-1428).
- **MCP status:** `McpServerStatus{status: connected|failed|needs-auth|pending|disabled, tools[], source, scope}` (d.ts:1231-1281).
- **Account and limits:** `accountInfo()`, `rate_limit_event`, `usage_EXPERIMENTAL…()` (5-hour, 7-day and per-model windows; null for API-key sessions) (d.ts:3037-3056).
- **Misc:** `prompt_suggestion` (opt-in), `agentProgressSummaries`, `readFile()` for remote viewers (d.ts:3075), `system/files_persisted`.

---

## 10. Gaps, risks and adapter design notes

**Risks**

- **Policy.** Third-party products may not offer claude.ai login without approval (docs/agent-sdk/overview). Default to API key or the user's own CLI config, gated behind explicit user opt-in, and get a decision from the product owner.
- **Churn.** The d.ts is about 9,900 lines, with fields annotated "absent on older CLIs" and "EXPERIMENTAL". Pin the SDK version, decode leniently (unknown → `custom`/ignored), and gate on `capabilities`.
- **Defaults that bite.**
  - Omitted `permissionMode` may mean `auto` (d.ts:1979).
  - `env` replaces the environment (d.ts:1645).
  - Interrupt kills background tasks unless `perTaskStopAffordance` is set (d.ts:1799-1802).
  - Without `forwardSubagentText` you only see subagent tool calls.
  - Glob and Grep are absent by default on macOS and Linux, so search shows up as `Bash` running `find`/`grep` (docs/tools-reference).
  - Todo/Task tools are absent on newer models.
- **Usage double counting.** Assistant frames repeat `message.id`. Per-step `output_tokens` is a placeholder (docs/agent-sdk/cost-tracking).
- **Process cost.** About 230+ MB per live process. Idle threads should `close()` and later `resume`.

**Adapter design**

- **Ownership and correlation.** One `ClaudeSession` actor per ace thread owns one `Query`. Stamp `uuid` on every outbound `SDKUserMessage` and correlate via `user_message_uuid(s)`.
- **Agent tree.**
  - The root agent is `session_id`.
  - Child agent id = `task_id` (from `task_started` with `task_type:'local_agent'`), keyed also by `tool_use_id`.
  - `parentId` comes from the spawning frame's `parent_tool_use_id`: null means root, otherwise look up the agent that owns that tool_use.
  - `spawn_depth` serves as a sanity check.
  - Route every frame to `agentByToolUseId[parent_tool_use_id] ?? root`.
- **Status derivation per agent.**
  - `working{activity}` comes from in-flight `tool_use` or `stream_event`, `status.requesting`/`compacting`, and `tool_progress`.
  - `blocked{human}` while a `canUseTool`, elicitation or dialog for that `agentID` is pending.
  - `blocked{subagents}` while the agent has running child agents and its own `Agent` tool_use is unresolved (foreground).
  - `blocked{background_task}` when the root is idle but non-ambient background tasks exist.
  - `blocked{rate_limit}` from `rate_limit_event.rejected` or `api_retry` with `error:'rate_limit'`.
  - `blocked{network}` from `api_retry` with `error_status:null`.
  - `interrupted` from `terminal_reason: aborted_*`.
  - `failed` from `task_notification.failed`, an `is_error` result or process exit.
  - `unresponsive` when no frames arrive for N s while working. `tool_progress` heartbeats and `keep_alive` reset the timer.
- **Thread status** = fold over the subtree, with precedence blocked{human} > working > blocked{other} > failed > idle.

**Mapping to ace canonical model: tool kinds**

| Claude tool name(s)                                                                                                                                                 | ace kind                                      | Notes                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Bash`, `PowerShell`                                                                                                                                                | `shell`                                       | `run_in_background` → background task; `Monitor` is a separate entry                  |
| `Monitor`                                                                                                                                                           | `shell` (watch)                               | Mark as a background task                                                             |
| `Read`                                                                                                                                                              | `file.read`                                   | `pages` for PDFs                                                                      |
| `Edit`                                                                                                                                                              | `file.edit`                                   |                                                                                       |
| `Write`                                                                                                                                                             | `file.write`                                  |                                                                                       |
| `NotebookEdit`                                                                                                                                                      | `notebook`                                    | `edit_mode:'delete'` is a cell delete                                                 |
| _(none)_                                                                                                                                                            | `file.delete` / `file.move`                   | No dedicated tool; happens via `Bash` (`rm`, `mv`). Optional heuristic classification |
| `Glob`, `Grep`, `LSP`, `ToolSearch`                                                                                                                                 | `search`                                      |                                                                                       |
| `WebSearch`                                                                                                                                                         | `web.search`                                  |                                                                                       |
| `WebFetch`                                                                                                                                                          | `web.fetch`                                   | May be detached                                                                       |
| `mcp__<server>__<tool>`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`, `RefreshMcpTools`, `WaitForMcpServers`                            | `mcp`                                         | Server and tool parsed from the name                                                  |
| `Agent` / `Task`, `Workflow`                                                                                                                                        | `agent.spawn`                                 | `Workflow` spawns many agents                                                         |
| `SendMessage`, `ListAgents`, `SubagentHandback`                                                                                                                     | `agent.message`                               |                                                                                       |
| `TaskStop`, `TaskOutput` (legacy `KillShell`, `BashOutput` **[unverified aliases]**)                                                                                | `custom` (task control)                       | Links to a task id                                                                    |
| `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`                                                                                                      | `plan/todo update`                            |                                                                                       |
| `EnterPlanMode`, `ExitPlanMode`                                                                                                                                     | `plan/todo update` + Interaction(plan review) |                                                                                       |
| `AskUserQuestion`                                                                                                                                                   | `ask_user` + Interaction(question)            |                                                                                       |
| `Skill`                                                                                                                                                             | `custom` (skill)                              | Forked skills spawn subagent-like children                                            |
| `EnterWorktree`, `ExitWorktree`                                                                                                                                     | `custom` (workspace)                          |                                                                                       |
| `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`                                                                                           | `custom` (schedule)                           |                                                                                       |
| `PushNotification`, `SendUserFile`, `Artifact`, `ReportFindings`, `SendFeedback`, `EndConversation`, `Projects`, `ShareOnboardingGuide`, `ShowOnboardingRolePicker` | `custom`                                      |                                                                                       |
| _(no browser or image tool in the built-in set)_                                                                                                                    | `browser`, `image`                            | Only via MCP (e.g. Claude in Chrome `--chrome`)                                       |

Always keep the raw `name`, `input`, `tool_use_id`, `tool_use_result` and `parent_tool_use_id`.

**Interactions:**

- `can_use_tool` becomes `approval`, `AskUserQuestion` becomes `question`, and `ExitPlanMode` becomes `plan_review`.
- `elicitation` becomes an MCP form or URL Interaction, and `request_user_dialog` becomes `custom`.
- The key is `requestId` (globally) plus `toolUseID`/`agentID` (routing).
- Resolution comes from any device. The daemon resolves the pending promise and closes the Interaction on `signal.abort` or `control_cancel_request`.
- Persist pending Interactions. After a daemon restart, use `resume` and accept that the in-flight ask is lost unless `defer` was used.

---

## Open questions / needs live verification

1. Is `system/session_state_changed` emitted to SDK consumers by default, and in what order relative to `result` and `task_notification`?
2. Is a subagent's `task_id` equal to its `agentId` (and to the transcript filename `agent-<id>`)?
3. Exact `canUseTool` input for `ExitPlanMode` (injected `plan`?), and what `allow` vs `deny` does to the permission mode.
4. Semantics of `SDKUserMessage.priority` (`now|next|later`). Is mid-turn injection treated as steering?
5. Is there a `Query` method for `get_task_output` and `cancel_async_message`, or must ace use the raw control channel?
6. In streaming mode, does a background-subagent completion always produce a full new turn (`system/init` … `result`) even if the user never sends anything? Local transcripts show 262 `task-notification`-origin entries, which suggests yes.
7. Behaviour of `forwardSubagentText` with `includePartialMessages`: do subagent `stream_event`s stream?
8. Background-subagent permission prompts arrive via `canUseTool` with `agentID`. Confirm they never auto-deny in SDK mode.
9. Legal/policy answer on subscription login (TL;DR #5).

## Sources

- `@anthropic-ai/claude-agent-sdk@0.3.287`: `sdk.d.ts`, `sdk-tools.d.ts`, `README.md`, `package.json`, `manifest.json`, `sdk.mjs` (spawn args), in `/tmp/research-claude/node_modules/@anthropic-ai/claude-agent-sdk/`.
- `claude --help` / `claude --version` (2.1.286, local).
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- https://code.claude.com/docs/en/agent-sdk/cost-tracking
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/tools-reference
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/monitoring-usage
- Local transcripts `~/.claude/projects/-Users-arpanbhandari-Code-ace/*.jsonl` and `…/<session>/subagents/agent-*.jsonl`/`.meta.json`. Read-only, structure only.
