# Codex provider research (for the ace adapter)

Researched 2026-10-01/02. Sources: `openai/codex` at commit `7135b303d918fc80fecb8053a92173bd211d2c0a` (2026-10-02; all repo paths below are relative to that checkout, `codex-rs/...`); schemas generated locally from the installed `codex-cli 0.159.1` via `codex app-server generate-ts --experimental` / `generate-json-schema --experimental`; public docs at developers.openai.com/codex (markdown via `.md` suffix). The 0.159.1 schema and HEAD agree on every method and item type checked: 167 client requests, 11 server requests, 83 notifications, and the same 19 `ThreadItem` variants. Anything not confirmed in source or schema is marked **(unverified)**.

## TL;DR

**Use `codex app-server` (JSON-RPC v2) as the only live surface.** Spawn it over stdio from the ace daemon, opt into `experimentalApi`, and pin behavior to the schema generated from the installed binary. Use stored history (`thread/list`, `thread/read`, `thread/turns/list`) for import. Hooks, OTel and raw rollout JSONL are only fallback or diagnostic channels. `codex exec --json` and the TS SDK lose approvals and most subagent detail, so ace should not use them.

Key facts:

1. **Every thread has its own runtime status, but no subtree status.** `ThreadStatus` is `notLoaded | idle | systemError | active{activeFlags: [waitingOnApproval|waitingOnUserInput]}` (`app-server-protocol/src/protocol/v2/thread.rs:1665-1683`). It is computed from "turn running" plus pending approval and user-input counters only (`app-server/src/thread_status.rs:445-469`). Background terminals and running subagents are not reflected, so ace must derive subtree status itself.
2. **Subagents are first-class threads.** A `Thread` carries `parentThreadId`, `sessionId` (tree root), `agentNickname`, `agentRole`, and `source: {subAgent: {thread_spawn: {parent_thread_id, depth, agent_path, ...}}}` (`v2/thread_data.rs:204-290`; `SubAgentSource.ts`). Child events stream live on the same connection, but **no `thread/started` is sent for spawned children**. Clients discover them from parent `collabAgentToolCall` (V1) or `subAgentActivity` (V2) items (`v2/item.rs:372-403`), and child events can arrive before the spawn item (§4).
3. **`turn/completed` does not mean the agent is done.** Several mechanisms start or continue work without a client request:
   - Background unified-exec processes outlive the turn and emit `commandExecution` completion later (`core/src/unified_exec/async_watcher.rs:155-240`).
   - Active thread goals auto-start continuation turns when idle (`ext/goal/src/runtime.rs:425-505`).
   - The server-side queue auto-dispatches on idle (`ext/queue/src/service.rs:549-565`).
   - Subagents keep running after the parent's turn ends, and `turn/interrupt` does not cascade to them (see §4).
4. **Approvals are JSON-RPC requests from the server to the client.** They are scoped to `threadId`/`turnId`/`itemId`, fan out to every connection subscribed to the thread (first answer wins), and get confirmed by `serverRequest/resolved`. They are replayed to a client that re-attaches with `thread/resume` (`app-server/src/outgoing_message.rs:330-451`; `request_processors/thread_lifecycle.rs:806-808`). Pending requests are aborted when the turn ends (`bespoke_event_handling.rs:184-187`).
5. **Control surface:**
   - Steer: `turn/steer`. `turn/start` also steers if a turn is active (`turn_processor.rs:651-675`).
   - Interrupt: `turn/interrupt` responds only after `TurnAborted`.
   - Server-side queue (experimental): `thread/queue/*`.
   - Fork with turn boundaries: `thread/fork`.
   - Rewind history: `thread/revert`. It changes history only, not files, and `thread/rollback` was removed.
   - Compaction: `thread/compact/start`.
   - Settings changes: `thread/settings/update` (subsequent turns) and `turn/settings/update` (the running turn).
   - Review mode: `review/start`.
6. **Retries are visible.** `error` notifications carry `willRetry: true` for transient stream errors (`bespoke_event_handling.rs:1054-1071`). Terminal failures carry typed `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`, `serverOverloaded`, `responseStreamDisconnected`, ...) (`v2/shared.rs:76-128`).
7. **There is no heartbeat and no protocol version number.** Version comes from `initialize.userAgent` (`<originator>/<semver> (...)`, `login/src/auth/default_client.rs:152-166`). Notification envelopes carry `emittedAtMs` (`common.rs:2062-2078`). Liveness has to come from process supervision plus ace's own timers.
8. **Licensing risk.** The docs say: "App-server authentication has never been permitted for commercial or hosted services", and they steer third parties to "Sign in with ChatGPT" (https://developers.openai.com/codex/app-server.md, "Auth endpoints"). A local, user-run ace that relies on the user's own `codex login` is the posture the docs tolerate ("local or open-source application"). A hosted ace is not.

## 1. Integration surfaces

| Surface                                                                                                | What it gives                                                                                                                                                                                                                          | Verdict                                |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `codex app-server` JSON-RPC v2                                                                         | Full thread/turn/item lifecycle, streaming deltas, approvals and questions as server requests, subagent threads, history, account, MCP, skills, models. Used by the VS Code extension and Desktop (docs §intro; `codex --remote` TUI). | **Primary**                            |
| Stored threads via app-server (`thread/list`, `thread/read`, `thread/turns/list`, `thread/items/list`) | Import of past sessions, including TUI and Desktop ones, without parsing files.                                                                                                                                                        | **Secondary (history/import)**         |
| `codex exec --json` / TS SDK                                                                           | Non-interactive JSONL. See §1a.                                                                                                                                                                                                        | Not for ace (no interactive approvals) |
| Rollout JSONL files (`~/.codex/sessions/...`)                                                          | Raw `response_item` records with original tool name and arguments. See §8.                                                                                                                                                             | Forensic fallback only                 |
| Hooks / `hook/started`, `hook/completed`                                                               | Lifecycle side channel. See §1a.                                                                                                                                                                                                       | Optional                               |
| OTel (`[otel]`)                                                                                        | Metrics and traces. See §1a.                                                                                                                                                                                                           | Diagnostics only                       |

### 1a. Secondary surfaces (detail)

- **`codex exec --json`** (alias `--experimental-json`, `exec/src/cli.rs:63-69`) is built on an in-process app-server client (`exec/src/lib.rs:19-59, 731`).
  - It emits flattened JSONL: `thread.started`, `turn.started`, `turn.completed{usage}`, `turn.failed`, `item.started`/`updated`/`completed`, `error` (`exec/src/exec_events.rs:10-73`).
  - Item types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error` (`:106-133`).
  - It drops every notification not on the primary thread, so subagent transcripts are lost (`lib.rs:1664-1704`).
  - It also drops several collab tools (`event_processor_with_jsonl_output.rs:248-251, 299`).
  - It has no text deltas (`:345`).
  - It forces `approvalPolicy=never` and rejects approval requests with "not supported in exec mode" (`lib.rs:589-591, 2063-2110`).
  - Verdict: unsuitable for ace.
- **TS SDK `@openai/codex-sdk`** wraps `codex exec --experimental-json` (`sdk/typescript/src/exec.ts:95, 173-174`).
  - Its API is `Codex.startThread()` / `resumeThread()`, then `Thread.run()` / `runStreamed()` (`src/codex.ts:11-44`, `src/thread.ts:66, 119`).
  - Its item union lacks `collab_tool_call` (`src/items.ts:120-128`).
  - It inherits every exec limitation.
- **Python SDK `openai-codex`** is a typed app-server JSON-RPC client over `codex app-server --listen stdio://` (`sdk/python/src/openai_codex/client.py:215, 256`). It pins its own CLI wheel (`sdk/python/pyproject.toml:6,17`). It is a useful reference for an app-server client.
- **`codex mcp-server` has been removed.** It is not in 0.159.1, and `codex-rs/mcp-server` no longer exists. The docs say: "The `codex mcp-server` command and the standalone `codex-mcp-server` binary have been removed… migrate to the Codex app server" (https://developers.openai.com/codex/guides/agents-sdk.md).
- **Rollout files.**
  - Path: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>[_<rolloutId>].jsonl`; archived files go to `archived_sessions/` (`rollout/src/recorder.rs:1728-1742`, `rollout/src/lib.rs:86-87`).
  - Lines are `RolloutLine{timestamp, ordinal?, type: session_meta|response_item|inter_agent_communication|compacted|turn_context|token_usage_record|event_msg|...}` (`history/src/lib.rs:355-366`, `history/src/rollout_payload.rs:31-70`).
  - `session_meta` has `session_id`, `forked_from_id`, `parent_thread_id` (`protocol/src/protocol.rs:3123-3241`).
  - **Not a stable format.** `RolloutLine` intentionally has no `Deserialize`, and readers "must use codex_rollout's canonical parser" (`history/src/lib.rs:357-359`).
  - Cold files may be `.zst`-compressed behind the `local_thread_store_compression` flag (`rollout/src/compression.rs:31`, `features/src/lib.rs:189-191`).
  - `codex migrate-rollouts` converts files to "paginated" SQLite history (`thread-store/src/local/rollout_migration.rs:1-9`).
  - SQLite DBs (`state_5`, `goals_1`, `queue_1`, `thread_history_1`, ...) carry the schema version in the filename (`state/src/sqlite.rs:34-39`).
  - Use app-server history APIs instead.
- **Hooks.**
  - Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt` (`app-server-protocol/src/protocol/v2/hook.rs:19-21`; https://developers.openai.com/codex/hooks.md).
  - Config lives in `hooks.json` or `[[hooks.<Event>]]` in `config.toml`, and hooks must be trusted by hash.
  - The app-server already surfaces them through `hooks/list`, `hook/started`, and `hook/completed`. ace does not need to install hooks.
- **OTel.**
  - Configured via `[otel]` with `exporter`, `trace_exporter`, `metrics_exporter` = `none|otlp-http|otlp-grpc` (`config/src/types.rs:600-660`).
  - Exported events include `codex.conversation_starts`, `api_request`, `sse_event`, `tool_decision`, and `tool_result`.
  - Exports are batched, so it is no use for liveness (https://developers.openai.com/codex/config-advanced.md).
- **Shared daemon.**
  - Run with `codex app-server daemon start|stop|version|...`. Each command prints one JSON object (`app-server-daemon/README.md`).
  - Socket: `$CODEX_HOME/app-server-control/app-server-control.sock` (`app-server-transport/src/transport/mod.rs:53-70`). `codex app-server proxy` bridges stdio to it.
  - The TUI auto-attaches when `daemon_auto_start` is on (default true, `features/src/lib.rs:115-116`; `tui/src/startup_orchestration.rs:509-512`).
  - `thread/started` is broadcast to all connections, while turn and item events go only to subscribers (`app-server/src/outgoing_message.rs:199-209, 741-776`).
  - If ace attached to this daemon, it could see TUI-started threads live and join them with `thread/resume`. **Inferred, not tested.**
  - Desktop appears to use its own stdio app-server (`app-server/README.md:127`), so it would not be shared. **Unverified.**
  - Recommendation: start with a private app-server owned by ace. Attaching to the daemon could later give cross-client live visibility.
- **Legacy `notify`** runs a program with an `agent-turn-complete` payload and is slated for removal (`hooks/src/legacy_notify.rs:13-44`).

## 2. Launch, auth, process model

- **Spawn.** Run `codex app-server` (stdio JSONL, the default). Other transports: `--listen unix://[PATH]` (WebSocket over UDS), `--listen ws://IP:PORT` (documented as "experimental and unsupported", with `/readyz` and `/healthz` probes, bounded queues, and `-32001` "Server overloaded; retry later.") and `off` (docs §Protocol, app-server.md lines 57-104; `codex app-server --help`). WebSocket auth uses `--ws-auth capability-token|signed-bearer-token` (same).
- **Handshake.** Send `initialize{clientInfo{name,title,version}, capabilities{experimentalApi, optOutNotificationMethods, mcpServerOpenaiFormElicitation, requestAttestation, explicitGatewayOauth, extensions}}`, then the `initialized` notification. The response is `{userAgent, codexHome, platformFamily, platformOs}` (`app-server-protocol/src/protocol/v1.rs:29-84`). Experimental methods and fields are rejected with `"<descriptor> requires experimentalApi capability"` unless the client opts in (docs §Experimental API). Many APIs ace needs are experimental:
  - `thread/queue/*`, `turn/settings/update`, `thread/settings/update`
  - `thread/backgroundTerminals/*`, `collaborationMode/list`
  - `parentThreadId` and `ancestorThreadId` filters
  - `item/tool/requestUserInput` and dynamic tools
- **`clientInfo.name` is sent to OpenAI.** It identifies the client to the "OpenAI Compliance Logs Platform". Enterprise integrations are asked to register (docs §Initialization).
- **Process model.**
  - **Multiplexed.** One app-server process hosts many threads. `thread/start` auto-subscribes the calling connection, and `thread/unsubscribe` unloads a thread after 30 minutes with no subscribers and no activity, emitting `thread/closed` (docs §Unsubscribe).
  - **Multiple connections.** These are possible on the socket and WebSocket transports, and per-thread notifications go to subscribed connections (`ThreadScopedOutgoingMessageSender`, `outgoing_message.rs:145-207`).
  - **Recommendation.** Run one long-lived app-server per ace daemon (per `CODEX_HOME`), not one per thread. The TUI auto-attaches to the shared `codex app-server daemon`. Desktop appears to run its own stdio server **(unverified)** (§1a). The docs also say the app-server command and WebSocket transport "are experimental and aren't supported for production workloads" (app-server.md L55).
- **Session source tag.** Threads started over the stdio transport are tagged `SessionSource::VSCode` by default (`app-server/src/lib.rs:443-453`).
- **Config.**
  - Process level: `-c key=value` (TOML-parsed), `--enable` / `--disable <feature>`, `--strict-config` (CLI help).
  - Thread level: `thread/start` accepts `model`, `modelProvider`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox` or `permissions` (named profile, experimental), `config` (arbitrary overrides), `baseInstructions`, `developerInstructions`, `ephemeral`, and `dynamicTools` (experimental) (`ThreadStartParams.ts`).
  - Writes: `config/read`, `config/value/write`, `config/batchWrite` modify `config.toml`.
- **Auth.**
  - `account/read` → `{account: apiKey | chatgpt{email, planType} | amazonBedrock, requiresOpenaiAuth}`.
  - `account/login/start` with `apiKey | chatgpt` (browser, local callback) | `chatgptDeviceCode` | `chatgptAuthTokens` (experimental, host-managed, with a `account/chatgptAuthTokens/refresh` server request on 401).
  - Notifications: `account/login/completed`, `account/updated{authMode, planType}` (docs §Auth endpoints, lines 1912-2215).
  - The app-server shares `~/.codex/auth.json` with the CLI, so a user who ran `codex login` is already signed in. The `codexHome` returned by initialize tells ace which home is in use.
- **Version gating.**
  - There is no protocol version field. Parse the semver from `userAgent`.
  - Generate schemas from the installed binary at startup or CI (`generate-ts` / `generate-json-schema`; the docs say "Each output is specific to the Codex version you ran").
  - Treat unknown notifications and unknown `ThreadItem.type` values as pass-through raw events.
  - Probe optional methods and handle `-32601` (method not found).
  - `deprecationNotice` and `configWarning` notifications exist (`common.rs:2024-2025`).

## 3. Event stream

Full notification list (HEAD = 0.159.1): `common.rs:1934-2053`. The ones ace needs:

| Notification                                                                                                                                                                                             | Key payload                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread/started`                                                                                                                                                                                         | `{thread: Thread}`. Emitted for `thread/start`, `thread/fork`, and detached review only, **not** for spawned subagents (§4). Broadcast to all connections.                 |
| `thread/status/changed`                                                                                                                                                                                  | `{threadId, status}`                                                                                                                                                       |
| `thread/closed`, `thread/archived`, `thread/unarchived`, `thread/deleted`, `thread/name/updated`, `thread/settings/updated`, `thread/goal/updated`, `thread/goal/cleared`, `thread/queue/changed` (exp.) | Metadata and lifecycle                                                                                                                                                     |
| `turn/started`                                                                                                                                                                                           | `{threadId, turn{id, status:"inProgress", startedAt}}` (items cleared, `bespoke_event_handling.rs:155-183`)                                                                |
| `turn/completed`                                                                                                                                                                                         | `{threadId, turn{status: completed\|interrupted\|failed, error?, completedAt, durationMs}}` (`v2/thread_data.rs:386-403`, `v2/turn.rs:33-38`)                              |
| `item/started`, `item/completed`                                                                                                                                                                         | `{item, threadId, turnId, startedAtMs \| completedAtMs}`. `item/completed` is authoritative (docs §Items).                                                                 |
| `item/agentMessage/delta`                                                                                                                                                                                | `{threadId, turnId, itemId, delta}`                                                                                                                                        |
| `item/reasoning/summaryTextDelta` / `summaryPartAdded` / `textDelta`                                                                                                                                     | `summaryIndex` marks section boundaries. Raw reasoning only arrives when the model supplies it.                                                                            |
| `item/plan/delta`                                                                                                                                                                                        | Plan-mode plan text. The final `plan` item wins.                                                                                                                           |
| `item/commandExecution/outputDelta`                                                                                                                                                                      | stdout/stderr text chunks (capped at 8 KiB each, `unified_exec/async_watcher.rs:37-43`)                                                                                    |
| `item/commandExecution/terminalInteraction`                                                                                                                                                              | `{processId, stdin}`: agent wrote to a running terminal                                                                                                                    |
| `item/fileChange/patchUpdated`                                                                                                                                                                           | `{changes:[{path, kind: add\|delete\|update{move_path}, diff}]}`. `item/fileChange/outputDelta` is deprecated and no longer emitted.                                       |
| `item/mcpToolCall/progress`                                                                                                                                                                              | `{message}`                                                                                                                                                                |
| `turn/diff/updated`                                                                                                                                                                                      | `{threadId, turnId, diff}`: aggregated unified diff for the turn                                                                                                           |
| `turn/plan/updated`                                                                                                                                                                                      | `{turnId, explanation?, plan:[{step, status: pending\|inProgress\|completed}]}`. This is the `update_plan` todo tool. It is **not** a `ThreadItem`.                        |
| `thread/tokenUsage/updated`                                                                                                                                                                              | `{tokenUsage{total, last, modelContextWindow}}` (`v2/thread.rs:1934-1964`)                                                                                                 |
| `account/rateLimits/updated`                                                                                                                                                                             | Primary and secondary windows `{usedPercent, windowDurationMins, resetsAt}`, keyed by `limitId`. Piggybacks on token-count events (`bespoke_event_handling.rs:1585-1600`). |
| `error`                                                                                                                                                                                                  | `{error: TurnError, willRetry, threadId, turnId}` (`v2/notification.rs:62-69`)                                                                                             |
| `serverRequest/resolved`                                                                                                                                                                                 | `{threadId, requestId}`                                                                                                                                                    |
| `hook/started`, `hook/completed`, `model/rerouted`, `model/safetyBuffering/updated`, `model/verification`, `warning`, `guardianWarning`, `item/autoApprovalReview/started` / `completed`                 | Informational                                                                                                                                                              |

**`ThreadItem` variants** (`v2/item.rs:231-430`):

- Messages and reasoning: `userMessage{clientId, content: UserInput[]}`, `hookPrompt`, `agentMessage{text, phase: commentary|final_answer, delivery?:"async", questions?}`, `plan`, `reasoning{summary[], content[]}`.
- Command execution: `commandExecution{command, cwd, processId, source: agent|userShell|unifiedExecStartup|unifiedExecInteraction, status, commandActions[read|listFiles|search|unknown], aggregatedOutput, exitCode, durationMs}`.
- File changes: `fileChange{changes, status: inProgress|completed|failed|declined}`.
- Tool calls: `mcpToolCall{server, tool, arguments, result, error, appContext, durationMs}`, `dynamicToolCall{namespace, tool, arguments, contentItems, success}`, `functionCallOutput`.
- Multi-agent: `collabAgentToolCall`, `subAgentActivity`.
- Other: `webSearch{query, action: search|openPage|findInPage|other, results?}`, `imageView{path}`, `sleep`, `imageGeneration{status, revisedPrompt, result, savedPath}`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`.

Ordering per item is `item/started` → deltas → `item/completed`. Approval and guardian flows can emit a command's start before core's canonical item, and app-server deduplicates it (`bespoke_event_handling.rs:1073-1077`).

## 4. Subagents / multi-agent

**Enablement.**

- Multi-agent is on by default. The docs say "Current Codex releases enable subagent workflows by default" (https://learn.chatgpt.com/docs/agent-configuration/subagents.md).
- The version is resolved in `core/src/config/mod.rs:1595-1622`:
  1. Feature `multi_agent_v2` → V2.
  2. Else `[agents] enabled=false` → disabled.
  3. Else the model's `multiAgentVersion` from `model/list` (`disabled|v1|v2`, `v2/model.rs:138`).
  4. Else feature `multi_agent` (alias `collab`, stable, default on) → V1.
- Limits:
  - `[agents] max_concurrent_threads_per_session` (alias `max_threads`, default 6) and `max_depth` (default 1, V1 only) (`config/mod.rs:256-266`).
  - V2 default is 4 concurrent including root, so 3 children (`config/mod.rs:1624-1638`).
  - Custom agent roles live in `~/.codex/agents/*.toml` or `.codex/agents/` (subagents doc).

**Model tools.**

- V1 (`multi_agents_spec.rs`): `spawn_agent{message|items, agent_type, fork_context, model, reasoning_effort}`, `send_input{target, message, interrupt}`, `resume_agent`, `wait_agent{targets, timeout_ms}`, `close_agent` (which also closes descendants).
- V2 (namespace `collaboration`): `spawn_agent{task_name, message, agent_type, fork_turns, model, reasoning_effort}`, `send_message` (queue only), `followup_task` (triggers a turn), `interrupt_agent`, `list_agents{path_prefix}`, `wait_agent{timeout_ms}` (`core/src/tools/spec_plan.rs:1298-1427`).
- `CollabAgentTool` enum: `spawnAgent|sendInput|resumeAgent|wait|closeAgent|sendMessage|followupTask|interruptAgent|listAgents`.

**Identity and linkage.** A child is an ordinary thread (UUIDv7) with:

- `parentThreadId` and `sessionId` (tree root).
- `agentNickname` and `agentRole`.
- `canAcceptDirectInput` (exp.; false for V2 children, which reject direct `turn/start`).
- `source = {"subAgent": {"thread_spawn": {parent_thread_id, depth, agent_path, agent_nickname, agent_role}}}`. Note that `SubAgentSource` is snake_case inside a camelCase envelope (`v2/thread_data.rs:204-281`; `protocol/src/protocol.rs:2908-2925`).
- `agent_path` is `/root/<task_name>/...` in V2 and **null in V1** (`protocol/src/agent_path.rs:19-56`; `multi_agents/spawn.rs:120-126`). `depth` = parent depth + 1.
- There is no top-level `agentPath`/`depth` field on `Thread`.

**Live streaming.**

- When `AgentControl` spawns a child, the app-server attaches a listener **for every initialized connection**, not just the parent's owner. Child `turn/*`, `item/*`, and approval requests then stream on the same connection with the child's `threadId` (`app-server/src/lib.rs:1282-1300`; `request_processors/thread_lifecycle.rs:139-320`; `bespoke_event_handling.rs:785-789`).
- **No `thread/started` is emitted for spawned children.** It is only sent for `thread/start`, `thread/fork`, and detached review (`thread_processor.rs:1650, 5416`; `turn_processor.rs:1525`; verified by grep).
- Clients discover children from parent items:
  - **V1:** `collabAgentToolCall{tool: spawnAgent}`. `item/started` has empty `receiverThreadIds`. `item/completed` carries the child id and `agentsStates{[id]: {status: pendingInit|running|interrupted|completed|errored|shutdown|notFound, message}}` (`multi_agents/spawn.rs:82, 179`; `v2/item.rs:1281-1310`).
  - **V2:** no `collabAgentToolCall` for spawn at all. The parent emits `subAgentActivity{kind: started, agentThreadId, agentPath}` after spawn returns (`multi_agents_v2/spawn.rs:77-95, 224-234`). Later kinds are `interacted` (send_message/followup), `interrupted`, and `completed`.
  - Fallback: `thread/read` on an unknown `threadId`, or `thread/list{ancestorThreadId}`.

**Races.**

- The child's first input is submitted before the thread-created broadcast, and attachment runs as a separate task (`agent/control/spawn.rs:872-898`; `lib.rs:1293`). So **child `turn/started`/items can arrive before the parent's spawn item**.
- The official TUI drops events for unknown thread ids (`tui/src/app/app_server_events.rs:450-470`). ace must instead buffer by `threadId` and resolve parentage via `thread/read`.
- If the thread-created broadcast lags, the server logs `"thread_created receiver lagged; skipping resync"` and **never attaches** that child (`lib.rs:1302-1307`). Under heavy spawning, ace should poll `thread/loaded/list` and `thread/resume` any missing loaded descendants.

**Parent vs. child lifecycle.**

- Spawns return immediately. The parent's turn can complete and the parent can go `idle` while children are `active`. There is no "has running children" flag (`thread_status.rs:447-469`).
- V1 completion: a watcher injects a `<subagent_notification>` into the parent's context **without starting a turn** (`agent/control.rs:453-557`; `context/subagent_notification.rs`).
- V2 completion (`agent/control/completion.rs:27-143`):
  - It emits `subAgentActivity{kind: completed}` stamped with the parent's **old** `turnId`, which may already be finished.
  - It queues the child result with `trigger_turn=false`, so the parent sees it only on its next turn.
  - Net effect: after the root's `turn/completed`, the tree may still be working, and no new root turn starts automatically.
- `turn/interrupt` affects one thread only and does **not** cascade (`turn_processor.rs:1599-1640`; `core/src/session/mod.rs:4959-4966`). To stop a tree, ace must interrupt each active descendant.
- Approvals from children use the child's `threadId`. Children inherit the parent turn's approval policy, sandbox, and reviewer (`agent/child_config.rs:170-180`).
- Guardian "root handoff" (`agent/control/root_handoff.rs`, `user_authorization.rs`) is evidence for the auto-reviewer, not routing to the user.
- **Agent message board** (`ext/agent-message-board`; features `agent_message_board` + `multi_agent_v2`, under development) has no client API. It is only visible as tool-call items.

## 5. Status and liveness

- **Turn start and end.**
  - `turn/started` and `turn/completed` bracket each turn. `turn.status` is one of `completed | interrupted | failed`.
  - A failure is preceded by an `error` with `willRetry:false` (docs §Errors).
  - Core `TurnAborted` maps to `interrupted`. With the Guardian `strict` circuit-breaker, the turn carries `codexErrorInfo:"tooManyDenials"` (repo `app-server/README.md` "Guardian circuit-breaker errors").
- **Waiting on a human.** `thread/status/changed` → `active{activeFlags:["waitingOnApproval"]}` or `["waitingOnUserInput"]` while server requests are pending (`thread_status.rs:445-469`). Pending requests are tied to the current turn, and turn end aborts them (`bespoke_event_handling.rs:184-187`). The guard counters exist only for permission and user-input requests. **Unverified:** whether MCP elicitations and dynamic-tool calls set either flag.
- **Retry, rate limit, network.**
  - `error{willRetry:true}` comes from core `StreamError` ("intermediate error states for retries", `bespoke_event_handling.rs:1054-1071`). Map it to `blocked{on: network}` until the next delta or item.
  - Exhausted retries end the turn `failed` with `responseTooManyFailedAttempts` / `responseStreamDisconnected` / `httpConnectionFailed{httpStatusCode}`.
  - Quota failures arrive as `usageLimitExceeded` / `rateLimitExceeded` / `serverOverloaded` (`v2/shared.rs:76-128`). Combine them with `account/rateLimits/*` `resetsAt` for `blocked{on: rate_limit}`.
- **Background terminals.** Unified-exec PTYs survive the turn. The exit watcher later emits the final `commandExecution` completion using the original turn context (`unified_exec/async_watcher.rs:155-240`). **Unverified live:** the exact notification a client sees after `turn/completed`. ace can list and kill them with `thread/backgroundTerminals/list` / `terminate` / `clean` (experimental, docs lines 869-905). `ThreadStatus` ignores them, so ace's `blocked{on: background_task}` must come from this list plus `commandExecution` items still `inProgress`.
- **Self-started turns** (thread goes `idle` → `active` with no `turn/start` from ace):
  - goal continuation (`ext/goal/src/runtime.rs:425-505`)
  - queued-input dispatch on idle, skipped after an interrupt (`ext/queue/src/service.rs:549-565`)
  - child turns triggered by a parent's `followup_task` / `send_input` (§4); a V2 child's completion does _not_ start a parent turn
  - `thread/shellCommand` (docs lines 852-867)
  - `thread/compact/start` (docs lines 841-850)

  ace must treat `turn/started` it did not request as normal.

- **Long waits inside a turn.** These keep `active` with no output:
  - `clock.sleep` up to 12 h, ended early by new input (`core/src/tools/handlers/sleep.rs:26-60`).
  - The multi-agent `wait` tool.
  - `send_message_to_user_async` / `request_user_input_async`. These ask questions without ending the turn, and the answer arrives as a later user message (`send_message_to_user_async.rs:21-46`, `request_user_input_async.rs:22-60`). They surface as `agentMessage{delivery:"async", questions:[{title, options}]}` (`v2/item.rs:252-263`).
- **Errors outside turns.** `EventMsg::Error` always marks the thread `systemError` (`bespoke_event_handling.rs:1030-1034`). `systemError` is cleared on the next turn start (`thread_status.rs` `note_turn_started`).
- **Unloading.** `thread/closed` and status `notLoaded` follow an unsubscribe or idle unload.
- **Liveness.** There is no heartbeat or ping in the protocol (searched `app-server/src/{transport,message_processor,outgoing_message}.rs`). Use:
  - child-process exit and stdio EOF
  - `emittedAtMs` gaps while a turn is active
  - a cheap request such as `thread/loaded/list`

  The `unresponsive` state is ace's own heuristic.

## 6. Human-in-the-loop

Server requests (`common.rs:1779-1850`), each answered with a JSON-RPC response:

| Request                                                                         | Params                                                                                                                                                                                                                                                                                                    | Response options                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval`                                         | `kind: command\|writeStdin`, `threadId, turnId, itemId, approvalId?, startedAtMs, environmentId, reason?, command?, cwd?, commandActions?, networkApprovalContext{host, protocol}?, additionalPermissions?` (exp.), `proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments?, availableDecisions?` | `accept`, `acceptForSession`, `{acceptWithExecpolicyAmendment}`, `{applyNetworkPolicyAmendment}`, `decline`, `cancel` (`CommandExecutionApprovalDecision.ts`). Render only `availableDecisions` when present. |
| `item/fileChange/requestApproval`                                               | `threadId, turnId, itemId, startedAtMs, reason?, grantRoot?` (patch content is on the preceding `fileChange` item)                                                                                                                                                                                        | `accept`, `acceptForSession`, `decline`, `cancel`                                                                                                                                                             |
| `item/permissions/requestApproval`                                              | `cwd, reason, permissions` (network and filesystem)                                                                                                                                                                                                                                                       | `{permissions: granted subset, scope: turn\|session, strictAutoReview?}`                                                                                                                                      |
| `item/tool/requestUserInput` (exp.)                                             | `questions[{id, header, question, isOther, isSecret, options[]}]`, `isBlocking`, `autoResolutionMs` (deprecated)                                                                                                                                                                                          | `{answers: {[id]: {answers: string[]}}}`. Also used for app/connector tool approvals (docs lines 1458-1460).                                                                                                  |
| `mcpServer/elicitation/request`                                                 | `serverName, turnId?`, `mode: form \| openai/form \| url \| openai/userVerification`                                                                                                                                                                                                                      | `{action: accept\|decline\|cancel, content, _meta}`                                                                                                                                                           |
| `item/tool/call` (dynamic tools, exp.)                                          | Client-executed tool                                                                                                                                                                                                                                                                                      | `{contentItems, success}`                                                                                                                                                                                     |
| `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read` | Infrastructure                                                                                                                                                                                                                                                                                            | n/a                                                                                                                                                                                                           |
| `applyPatchApproval`, `execCommandApproval`                                     | Legacy v1                                                                                                                                                                                                                                                                                                 | Ignore                                                                                                                                                                                                        |

- **Routing.** Requests fan out to every subscribed connection, `serverRequest/resolved` follows the first answer, and `thread/resume` replays pending requests to a re-attaching connection. This matches ace's "resolve from any device" model if ace's daemon is the single app-server client and fans out itself.
- **Approval policy.** `approvalPolicy: untrusted | on-request | never | {granular{sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations}}` (`AskForApproval.ts`).
- **Auto-review.** `approvalsReviewer: user | auto_review | guardian_subagent` routes approvals to a reviewer subagent, emitting `item/autoApprovalReview/*` (`ApprovalsReviewer.ts`). `thread/approveGuardianDeniedAction` overrides a denial.
- **Plan mode.**
  - Use `collaborationMode{mode: plan|default, settings}` on `turn/start` or `thread/settings/update`. Presets come from `collaborationMode/list` (exp., `v2/collaboration_mode.rs`).
  - Plan text streams as a `plan` item.
  - Plan "review" is purely client-side. The TUI asks "Implement this plan?" and then sends `turn/start` with the default-mode mask and text "Implement the plan.", optionally in a fresh context (`tui/src/chatwidget/plan_implementation.rs:9-60`). ace's plan-review Interaction must therefore be synthesized from a completed `plan` item.

## 7. Control

| Action              | Method                                                                                             | Notes                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupt           | `turn/interrupt{threadId, turnId}`                                                                 | Response is deferred until `TurnAborted`, then the turn completes `interrupted` (`turn_processor.rs:1627-1648`).                                                                               |
| Steer               | `turn/steer{threadId, input, expectedTurnId}`                                                      | Fails if the turn id doesn't match. Review and compact turns are not steerable (`activeTurnNotSteerable`). `turn/start` on an active thread also steers (`turn_processor.rs:651-675`).         |
| Queue               | `thread/queue/add\|list\|update\|delete\|reorder\|start` + `thread/queue/changed` (exp.)           | Server-side durable queue, auto-dispatched on idle (`v2/thread.rs:926-1017`)                                                                                                                   |
| Resume              | `thread/resume{threadId}`                                                                          | Rejoins a running thread (replaying pending requests) or loads from disk. Supports config overrides.                                                                                           |
| Fork                | `thread/fork{threadId, lastTurnId \| beforeTurnId, ephemeral}`                                     | New id with `forkedFromId`. Mid-turn forks record an interruption marker (docs lines 597-637).                                                                                                 |
| Undo history        | `thread/revert{threadId, beforeTurnId}` + `thread/reverted`                                        | Changes history only, not files. `thread/rollback` was removed (repo `app-server/README.md` "Thread rollback"; absent from 0.159.1 schema; still listed as deprecated in the public docs).     |
| Compact             | `thread/compact/start`                                                                             | Returns `{}`. Shows up as a `contextCompaction` item in a turn.                                                                                                                                |
| Mid-thread settings | `thread/settings/update` (exp.)                                                                    | Model, effort, summary, sandbox, permissions, approval policy, reviewer, collaboration mode, cwd. Emits `thread/settings/updated`. Per-turn overrides on `turn/start` persist for later turns. |
| Mid-turn settings   | `turn/settings/update` (exp.)                                                                      | Model, effort, summary, reviewer, service tier for the running turn only                                                                                                                       |
| Review              | `review/start{target: uncommittedChanges\|baseBranch\|commit\|custom, delivery: inline\|detached}` | Detached review creates a new thread (docs lines 1082-1146)                                                                                                                                    |
| User shell          | `thread/shellCommand`                                                                              | Runs unsandboxed                                                                                                                                                                               |
| Goals               | `thread/goal/set\|get\|clear`                                                                      | Drives autonomous continuation                                                                                                                                                                 |
| Archive / delete    | `thread/archive`, `thread/delete`                                                                  | Cascade to spawned descendants                                                                                                                                                                 |

## 8. History / import

- **Listing.** `thread/list` is newest-first with a cursor. Filters: `modelProviders`, `sourceKinds`, `archived`, `isPinned`, `cwd`, `searchTerm`, `useStateDbOnly`, plus `parentThreadId` / `ancestorThreadId` (exp.) (docs lines 684-732).
  - The default `sourceKinds` is only `cli`, `vscode`. Pass `exec`, `appServer`, and `subAgent*` explicitly when importing everything.
  - Threads ace creates over stdio are tagged `vscode`.
- **Reading.**
  - `thread/read{includeTurns}` does not load or subscribe.
  - `thread/turns/list` (exp.) supports `itemsView: notLoaded|summary|full`.
  - `thread/items/list` (exp.) supports item anchors.
  - Full-history reads are deprecated for "paginated" threads, which cannot be created yet (docs lines 524-528; `v2/thread.rs` `ThreadReadParams`).
- **Rollout and SQLite.** See §1a.

## 9. Extras

- **Input types.** `UserInput` is one of `text{text_elements}`, `image{url|fileId, detail}`, `localImage{path}`, `audio`, `localAudio`, `skill{name, path}`, `mention{name, path}` (`UserInput.ts`). Check `model/list` → `inputModalities`.
- **Models.** `model/list` returns efforts, `isDefault`, `upgrade`, and the multi-agent runtime (`MultiAgentVersion.ts`).
- **MCP.**
  - Status and calls: `mcpServerStatus/list`, `mcpServer/startupStatus/updated`, `mcpServer/oauth/login`, `config/mcpServer/reload`, `mcpServer/tool/call`, `mcpServer/resource/read`.
  - A `required` MCP server that fails makes `thread/start` fail.
- **Skills and plugins.** `skills/list`, `skills/changed`, `skills/config/write`, `hooks/list`, `plugin/*` ("don't call from production clients yet"), `app/*` connectors.
- **Account.** `account/rateLimits/read` returns `rateLimitsByLimitId` and reset credits. Also `account/usage/read`. No slash-command catalog API was found. Slash commands are a TUI feature (`docs/slash_commands.md`), and skills are the protocol-level equivalent.
- **Filesystem and processes.** `fs/*` and `fs/watch`, `command/exec` (sandboxed one-off), `process/spawn` (unsandboxed, exp.), `fuzzyFileSearch*`.

## 10. Gaps, risks, churn

- **Churn is extreme.**
  - The `app-server/README.md` at HEAD is a pile of feature notes. The canonical doc is the website.
  - The public docs lag source. For example, they still list `thread/rollback` and `item/fileChange/outputDelta` (deprecated, not emitted).
  - About 40 % of the methods ace wants are `experimental`.
  - Mitigation: codegen types from `generate-ts --experimental` per installed version, keep a raw passthrough for unknown variants, and run contract tests against recorded transcripts.
- **No raw tool name for most items.** `commandExecution` and `fileChange` items don't carry the model's tool name (`exec_command` / `shell_command` / `write_stdin` / `apply_patch`). Only `mcpToolCall` and `dynamicToolCall` do. `rawResponseItem/completed` exists but is "internal-only" (`common.rs:1976-1979`). To keep "raw provider name+input" ace has two options:
  - store `{itemType, item JSON}` as the raw record
  - join with rollout `response_item` records by call id **(unverified that item ids equal call ids)**
- **No subtree status, no heartbeat, no background-task flag.** ace must derive them (§5, §Mapping).
- **`update_plan` is a turn-level notification, not an item.** Emit a synthetic tool call in ace if a todo tool call is wanted in the transcript.
- **Auth and ToS.** See TL;DR 8. `clientInfo.name` reaches OpenAI compliance logs.
- **WebSocket transport is "experimental and unsupported"**, and non-loopback listeners are unauthenticated by default. Keep stdio or UDS behind the ace daemon. Never expose app-server directly to mobile.

## Mapping to ace canonical model

| ace concept                | Codex source                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent (root)               | `Thread` with `parentThreadId == null`. `sessionId` = tree root id.                                                                                                                                                                                                                                                                                                                                                                |
| Agent (sub)                | `Thread` with `parentThreadId`, `source.subAgent.thread_spawn{depth, agent_path, agent_nickname, agent_role}`. Also `agentNickname`/`agentRole`. Discover via `collabAgentToolCall.receiverThreadIds` (V1), `subAgentActivity.agentThreadId` (V2), unknown `threadId`s in the stream (then `thread/read`), and `thread/list{ancestorThreadId}` / `thread/loaded/list`. Tree key: V2 `agent_path`; V1 uses `parent_thread_id` only. |
| Internal helper agents     | `source.subAgent` = `review` / `compact` / `memory_consolidation` / `other`, plus guardian reviewers. Show collapsed or hidden.                                                                                                                                                                                                                                                                                                    |
| `starting`                 | After `thread/start` (root) or child discovery, before the first `turn/started`, or `agentsStates[id].status == pendingInit`                                                                                                                                                                                                                                                                                                       |
| `working{activity}`        | `active` + in-progress item. Activity comes from the latest `item/started` type (reasoning, commandExecution, fileChange, mcpToolCall, webSearch, collabAgentToolCall, ...).                                                                                                                                                                                                                                                       |
| `blocked{human}`           | `activeFlags` contains `waitingOnApproval` / `waitingOnUserInput`, or an open server request. Async questions (`agentMessage.delivery=="async"`) are a non-blocking variant.                                                                                                                                                                                                                                                       |
| `blocked{subagents}`       | `collabAgentToolCall{tool: wait, status: inProgress}` on the parent, or (between turns) any descendant still active                                                                                                                                                                                                                                                                                                                |
| `blocked{background_task}` | Thread `idle` but `thread/backgroundTerminals/list` non-empty, or a `commandExecution` still `inProgress` after `turn/completed`. Also a `sleep` item in progress.                                                                                                                                                                                                                                                                 |
| `blocked{rate_limit}`      | `error{willRetry}` with `rateLimitExceeded`/`serverOverloaded`, or failed turn with `usageLimitExceeded` + `account/rateLimits` `resetsAt`                                                                                                                                                                                                                                                                                         |
| `blocked{network}`         | `error{willRetry:true}` with stream or connection errors                                                                                                                                                                                                                                                                                                                                                                           |
| `idle`                     | `thread/status` `idle` and none of the above                                                                                                                                                                                                                                                                                                                                                                                       |
| `interrupted`              | `turn/completed{status: interrupted}`                                                                                                                                                                                                                                                                                                                                                                                              |
| `failed`                   | `turn/completed{status: failed}` (keep `codexErrorInfo`), or `systemError`                                                                                                                                                                                                                                                                                                                                                         |
| `unresponsive`             | ace heuristic: process dead, stdio closed, or no events for N s while `active` and nothing pending                                                                                                                                                                                                                                                                                                                                 |
| Thread status              | Fold over the subtree. Active if any agent is active or blocked. Idle only when all are idle and no background terminals are running.                                                                                                                                                                                                                                                                                              |
| Interaction: approval      | `item/commandExecution/requestApproval` (+ `networkApprovalContext`), `item/fileChange/requestApproval`, `item/permissions/requestApproval`. Key = JSON-RPC request id + `threadId`. Close on `serverRequest/resolved`.                                                                                                                                                                                                            |
| Interaction: question      | `item/tool/requestUserInput`, `mcpServer/elicitation/request`. Async questions are answered with `turn/steer` or `turn/start`.                                                                                                                                                                                                                                                                                                     |
| Interaction: plan review   | Synthesized from a completed `plan` item in `collaborationMode: plan`. Resolve with `turn/start{collaborationMode: default}`.                                                                                                                                                                                                                                                                                                      |

| ace tool kind                  | Codex item / signal (raw name)                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`                        | `commandExecution` (`exec_command`/`shell_command`/`shell`; `write_stdin` → `terminalInteraction` or `kind: writeStdin` approval)                         |
| `file.read`, `search`          | `commandExecution.commandActions[type: read\|listFiles\|search]`. Codex reads files via shell; there is no dedicated read tool.                           |
| `file.edit/write/delete/move`  | `fileChange.changes[].kind` = `update` (with `move_path` → move) / `add` / `delete` (`apply_patch`)                                                       |
| `web.search`, `web.fetch`      | `webSearch.action` = `search` / `openPage`, `findInPage`                                                                                                  |
| `mcp`                          | `mcpToolCall{server, tool, arguments}`                                                                                                                    |
| `agent.spawn`, `agent.message` | `collabAgentToolCall{tool: spawnAgent}` / `sendInput`, `sendMessage`, `followupTask`, `resumeAgent`, `interruptAgent`, `wait`, `closeAgent`, `listAgents` |
| `plan/todo update`             | `turn/plan/updated` (`update_plan`); plan-mode `plan` item                                                                                                |
| `image`                        | `imageView` (`view_image`), `imageGeneration`                                                                                                             |
| `ask_user`                     | `item/tool/requestUserInput` (`request_user_input`), `agentMessage{delivery: async}` (`request_user_input_async`, `send_message_to_user_async`)           |
| `custom`                       | `dynamicToolCall`, `functionCallOutput`, `sleep`, `hookPrompt`, `contextCompaction`, review-mode items                                                    |
| `browser`, `notebook`          | No dedicated item. Browser use comes via MCP/connectors **(unverified)**.                                                                                 |

## Open questions / needs live verification

1. Exact notification sequence when a background terminal exits after `turn/completed`: which `turnId`, and whether a new turn is started.
2. Whether `waitingOnApproval` is set for MCP elicitations and dynamic tool calls, and for child-thread approvals on the parent.
3. Whether `commandExecution.id` equals the Responses `call_id` in rollout files (needed for raw tool name and input joins).
4. Subagents:
   - whether child shutdown or close produces `thread/closed` or a status change
   - how many child events are buffered before the listener attaches
   - whether newer versions add `thread/started` for spawned children
   - how often the `thread_created` broadcast lag happens in practice
5. Behavior when two ace devices answer the same approval simultaneously: the second answer should be dropped silently. Verify that no error reaches the model.
6. Whether `turn/start` steering, instead of erroring, is stable behavior or an implementation detail.
7. Whether the shared `codex app-server daemon` should be used, so Desktop/TUI threads appear live in ace (see §1a).

## Sources

- Repo `openai/codex` @ `7135b303d918fc80fecb8053a92173bd211d2c0a`: `codex-rs/app-server-protocol/src/protocol/{common.rs, v1.rs, v2/*.rs}`, `codex-rs/app-server/{README.md, src/thread_status.rs, src/bespoke_event_handling.rs, src/outgoing_message.rs, src/lib.rs, src/request_processors/{turn_processor.rs, thread_lifecycle.rs}}`, `codex-rs/core/src/{unified_exec/async_watcher.rs, tools/handlers/*}`, `codex-rs/ext/{goal,queue}`, `codex-rs/tui/src/chatwidget/plan_implementation.rs`, `codex-rs/login/src/auth/default_client.rs`.
- Generated schema from `codex-cli 0.159.1`: `codex app-server generate-ts --experimental`, `generate-json-schema --experimental`.
- https://developers.openai.com/codex/app-server (.md): Protocol, Initialization, API overview, Threads, Turns, Review, Events, Errors, Approvals, Auth endpoints.
- https://learn.chatgpt.com/docs/agent-configuration/subagents.md
- More repo paths used: `codex-rs/core/src/{config/mod.rs, tools/spec_plan.rs, tools/handlers/multi_agents*/, agent/control*.rs, agent/child_config.rs, context/subagent_notification.rs}`, `codex-rs/protocol/src/{protocol.rs, agent_path.rs}`, `codex-rs/tui/src/app/{app_server_events.rs, thread_routing.rs, loaded_threads.rs}`, `codex-rs/exec/src/{lib.rs, cli.rs, exec_events.rs, event_processor_with_jsonl_output.rs}`, `sdk/typescript/src/*`, `sdk/python/*`, `codex-rs/{rollout, history, state, thread-store, hooks, app-server-daemon, app-server-transport, features, config}`.
- https://developers.openai.com/codex/guides/agents-sdk.md (mcp-server removal), https://developers.openai.com/codex/hooks.md, https://developers.openai.com/codex/config-advanced.md (OTel, notify), https://developers.openai.com/codex/noninteractive.md, https://developers.openai.com/codex/auth.md.
- `/tmp/t3code` was used only as a pointer to cross-check which methods exist. Nothing here is cited from it.
