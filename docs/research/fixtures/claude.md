# Claude fixtures (CLI 2.1.286, Agent SDK 0.3.287): status analysis

Analysed 2026-10-02 from `fixtures/claude/2.1.286/*.jsonl` (8 scenarios, recorded by `tools/recorder/src/providers/claude.ts`: streaming input, `includePartialMessages`, `forwardSubagentText`, `includeHookEvents`, `perTaskStopAffordance`, `settingSources: []`, `permissionMode: default` or `plan`). Read-only analysis; no sessions were started.

Citation form: `<fixture> t=<ms>` or `<fixture> #<seq>`. `d.ts:N` = `sdk.d.ts` in SDK 0.3.287. "Root" = the main session agent (`parent_tool_use_id: null`).

---

## TL;DR

1. **`session_state_changed` is never delivered** (0 frames in all 8 fixtures). It is not missing; the SDK hides it. The SDK sets `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` in the child env by default (sdk.mjs). The CLI then emits the frame with `sdk_host_only: true`, and the SDK consumes it internally (`if(e.state==="idle"){if(this.resultReceived)this.endRun()}` … `if("sdk_host_only"in e&&e.sdk_host_only===!0)continue`). Consumers get it only when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set. The same branch is in the local 2.1.286 binary (`if(a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)Di({type:"system",subtype:"session_state_changed",state:e})`). This is static evidence only; no fixture was recorded with the variable set.
2. **The reliable idle signal in these fixtures is a fold of several signals**: `result` (turn end), the `background_tasks_changed` level set being empty, no open `canUseTool`, no live child task, and no **pending wake**. A pending wake is a background-task `task_notification` that arrived outside a turn. It is always followed 12–82 ms later by an unprompted `system/init` turn (subagent-background t=6947→6959, background-shell t=18499→18581).
3. **Background completions start a turn with no visible user message.** The only marker of the trigger is `result.origin = {kind:"task-notification", producer:"session-task"}`, and it arrives at the **end** of the run (background-shell #87, subagent-background #90).
4. **`task_id` = `agentId` = `canUseTool.options.agentID`** = the `tasks/<id>.output` file stem (subagent t=4061, #50, #57).
5. **ExitPlanMode `canUseTool` input contains `plan` and `planFilePath`.** The CLI injects them: the model's wire input was `{}` (plan-review #233 `wire_tool_inputs`). On deny, the turn continues and ends with `end_turn`.
6. **No subagent `stream_event`s.** `forwardSubagentText` gives complete `assistant` frames for child text only (0 stream_events with non-null parent across all fixtures). Child thinking was never seen.
7. **An interrupt ends the turn with `result/error_during_execution`, `is_error: true`, `terminal_reason: "aborted_streaming"`.** That must not map to `failed`. A background Bash started earlier survived the interrupt and was still live when the recorder stopped (interrupt t=11596…21109).

---

## 1. Per-scenario status sequences (condensed)

Notation: `init` = `system/init`, `req` = `system/status{status:"requesting"}`, `bg[...]` = `system/background_tasks_changed.tasks`, `A(tool#id)` = assistant tool_use frame, `U(result#id)` = user tool_result frame. Stream events, `rate_limit_event` and `thinking_tokens` are omitted unless relevant. The user prompt send is **not recorded** by the driver, so t=0 ≈ query start.

### tool-read

| t | frame |
|---|---|
| 717 | init (permissionMode `default`) |
| 720 | req |
| 3012 | A(Read#…Ex7kAozR), with **no canUseTool**: Read is auto-allowed in `default` |
| 3024 | U(result#…Ex7kAozR) |
| 3031 | req |
| 4150/4898 | thinking_tokens 50/196 (thinking text is empty, signature only) |
| 4907 | A(text) |
| 4912 | **result/success** `terminal_reason:"completed"`, `stop_reason:"end_turn"`, `result_index:0` |

Nothing follows; settled at 13082.

### approval-edit

| t | frame |
|---|---|
| 787/789 | init, req |
| 3031/3046 | A(Read), U(result), auto-allowed |
| 3050 | req |
| 5353 | A(Edit#…zqATE2cT) |
| 5356 | **can_use_tool** Edit `{suggestions:[{type:"setMode",mode:"acceptEdits",destination:"session"}], displayName:"Edit", description:"src/math.ts", toolUseID, requestId}` (no `title`, no `agentID`) |
| 5356 | send allow |
| 5363 | U(result#…zqATE2cT) |
| 5369 | stream `message_delta`/`message_stop` for the Edit message, **after** the tool already ran |
| 5373 | req |
| 7006 | **result/success** completed |

### question

| t | frame |
|---|---|
| 562/564 | init, req |
| 2889 | A(AskUserQuestion#…TZzdDrkN) `{questions:[{question,header:"Indentation",multiSelect:false,options:[{label,description}×2]}]}` |
| 2892 | **can_use_tool** AskUserQuestion, `options.requiresUserInteraction: true` |
| 2892 | send allow `updatedInput.answers = {"Do you prefer Tabs or Spaces?": "Tabs"}` (keyed by question text, value = label string) |
| 2892 | stream `content_block_stop` for that block arrives **after** the can_use_tool frame (#21 vs #23) |
| 2897 | U(result) `"Your questions have been answered: …"`, TUR echoes `questions` + `answers` |
| 2901 | req |
| 4963 | **result/success** completed |

### plan-review (permissionMode `plan`, decision `reject`)

| t | frame |
|---|---|
| 659/661 | init `permissionMode:"plan"`, req |
| 4660/6914 | A(Bash `git ls-files && …`), U(result `is_error:true`, exit 1). Auto-allowed in plan mode. Wire input had `cd <WORKSPACE> && …` (#34 `wire_tool_inputs`); the CLI strips the `cd` in `message.content` and records cwd in `wire_ingest_context` |
| 10563/11593 | A(Bash cat …), U(result), auto-allowed |
| 20437/20442 | A(Write `<HOME>/.claude/plans/plan-how-you-would-eager-wren.md`), U(result). **Auto-allowed, written outside the workspace** |
| 20910/20912 | A(ToolSearch `select:ExitPlanMode`), U(result `tool_reference`, `total_deferred_tools:24`). ExitPlanMode is a deferred tool |
| 21482 | req |
| 23536 | A(ExitPlanMode#…HhGXEbjs). `message.content[].input` has `plan` and `planFilePath`; `wire_tool_inputs` = `{}` |
| 23537 | **can_use_tool** ExitPlanMode `input:{plan, planFilePath}`, `options.requiresUserInteraction:true` |
| 23537 | send deny `"Plan recorded. Do not implement it."` |
| 23540 | U(result `is_error:true`, content = deny message), `tool_result_meta:[{id, non_execution_kind:"permission-rule"}]` |
| 23542 | req. The turn **continues** |
| 29832 | **result/success** completed, `permission_denials:[{tool_name:"ExitPlanMode", tool_use_id, tool_input:{plan, planFilePath}}]` |

No frame reports a permission-mode change after the deny: no `status.permissionMode` and no later `init`.

### subagent (foreground)

| t | frame |
|---|---|
| 732/734 | init, req |
| 4055 | A(**Agent**#…gsXH6QfT) `{description, prompt}` with no `run_in_background`. `init.tools` lists it as `Task` (#0) |
| 4061 | **task_started** `{task_id:"a3268519e89ba2332", tool_use_id:…gsXH6QfT, subagent_type:"general-purpose", is_backgrounded:false, spawn_depth:1, task_type:"local_agent", prompt}` |
| 4064 | child `user` frame (parent=…gsXH6QfT) carrying the prompt text |
| 4068 | root stream `message_delta(tool_use)`/`message_stop`, **after** the child started |
| 6322 | **task_progress** `{description:"Running Count lines in all files under src", last_tool_name:"Bash", usage:{total_tokens, tool_uses, duration_ms}}` |
| 6326 | **can_use_tool** Bash, `options.agentID:"a3268519e89ba2332"`, `decisionReason:"find with '-exec' …"`. Arrives **before** the child's tool_use frame |
| 6326 | send allow |
| 6327 | child A(Bash#…4QzHd5c8) parent=…gsXH6QfT, `subagent_type`, `task_description` |
| 7151 | child U(result) |
| 9532 | child A(text) final report |
| 9555 | **task_updated** `{status:"completed", end_time}` |
| 9555 | **task_notification** `{status:"completed", output_file:…/tasks/a3268519e89ba2332.output, summary, usage}` |
| 9557 | root U(result#…gsXH6QfT) with `"[Subagent hand-back] …"` wrapper. TUR `{status:"completed", agentId, agentType, totalDurationMs, totalTokens, totalToolUseCount, usage, toolStats, resolvedModel}` |
| 9560 | req |
| 12091 | **result/success** completed, `subagent_stats.spawned:1, completed:1, max_depth:1` |

No `background_tasks_changed` at any point: foreground subagents are not in the level set.

### subagent-background

| t | frame |
|---|---|
| 697/699 | init, req |
| 3785 | A(Agent#…7v3BB5Z7) `{…, run_in_background:true}` |
| 3790 | **bg** `[{task_id:"a7b260f0f9eaf2aee", task_type:"local_agent", description}]` (level before edge) |
| 3791 | **task_started** `is_backgrounded:true, spawn_depth:1` |
| 3795 | U(result) "Async agent launched successfully…", TUR `{isAsync:true, status:"async_launched", agentId, outputFile, canReadOutputFile:true}` |
| 3804 | req |
| 4418 | **result/success** completed `result:"started"`, `result_index:0`, `subagent_stats.completed:0` |
| 5713 | child A(Read) parent=…7v3BB5Z7. **No child prompt `user` frame** for a background child |
| 5714 | task_progress `"Reading README.md"` |
| 5722 | child U(result) |
| 6929 | child A(text) |
| 6947 | **bg `[]`**, then task_updated completed, then task_notification completed (same ms, #52–54) |
| 6959 | **init**, a new turn with no user input and **no user frame** |
| 6959 | req |
| 9404 | **result/success** completed, `result_index:1`, `num_turns:1`, **`origin:{kind:"task-notification", producer:"session-task"}`** |

### background-shell

| t | frame |
|---|---|
| 577/578 | init, req |
| 2584 | A(Bash `sleep 15 && echo finished`, `run_in_background:true`) |
| 3485 | **bg** `[{task_id:"bblqdt0o5", task_type:"local_bash", description}]`, then **task_started** `{task_id, tool_use_id, description, is_backgrounded:true, task_type:"local_bash"}` (no `spawn_depth`/`subagent_type`/`prompt`) |
| 3489 | U(result) "Command running in background with ID: bblqdt0o5…", TUR `{backgroundTaskId:"bblqdt0o5", stdout:"", interrupted:false}` |
| 3493 | req |
| 4211 | **result/success** completed `result:"launched"`, `result_index:0` |
| 4211–18499 | **14.3 s with zero frames**: no keep_alive and no tool_progress reach the consumer |
| 18499 | **bg `[]`**, then task_updated completed, then task_notification `{status:"completed", summary:"Background command … completed (exit code 0)"}` (no `usage`) |
| 18581 | **init**, a new turn with no user input |
| 20945/20957 | A(Read the `.output` file), U(result) `"finished\n\n[exited with code 0]"` |
| 22426 | **result/success** completed, `result_index:1`, `origin:{kind:"task-notification", producer:"session-task"}` |

### interrupt

| t | frame |
|---|---|
| 698/700 | init, req |
| 4910 | A(Bash `sleep 60 && echo done`, `timeout:90000`) |
| 4912 | U(result `is_error:true`) `"<tool_use_error>Blocked: sleep 60 followed by: echo done. … use run_in_background: true…"`. The CLI refuses long foreground sleeps without a canUseTool |
| 4919 | req |
| 10772 | A(Bash same command, `run_in_background:true`) |
| 11596 | bg `[{task_id:"b16gy4sc4", task_type:"local_bash"}]`, task_started |
| 11599 | U(result "Command running in background…") |
| 11602 | req (waiting on the model; no stream yet) |
| 12912 | note interrupt-sent (armed 8 s after the first root Bash at 4910) |
| 12914 | note interrupt-result `{still_queued:[]}` (no `cancelled` key). This resolves **before** the turn ends |
| 12915 | user `{content:[{type:"text", text:"[Request interrupted by user]"}]}`, parent null, **no `origin`/`isSynthetic`** |
| 12916 | **result/error_during_execution** `is_error:true, terminal_reason:"aborted_streaming", stop_reason:"tool_use"` (stale), `errors:["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]` |
| → 21109 | stop "settled". **Task b16gy4sc4 never ended**: no bg change, task_updated or notification. With `perTaskStopAffordance` the interrupt spared it, and `q.close()` then killed the process |

This scenario did **not** exercise "interrupt a running foreground tool". The CLI blocked the foreground sleep and the interrupt landed while the model was being queried.

---

## 2. Open questions from claude-code.md

| # | Question | Status | Evidence / answer |
|---|---|---|---|
| 1 | Is `session_state_changed` emitted to SDK consumers, and in what order? | **Answered (no, by default).** Order is still unknown | 0 frames in all 8 fixtures (`grep -c session_state_changed` = 0). Mechanism: SDK sets `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` unless the host set it, the CLI emits `sdk_host_only:true`, and the SDK swallows the frame after using it for `endRun()`. Opt in with `env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` (binary strings in 2.1.286 and 2.1.287; `sdk.mjs` env registry). **Needs a fixture with that env set** to learn the order relative to `result` and `task_notification`. Until then the idle signal is the fold in §4. |
| 2 | `task_id` vs `agentId` vs transcript ids | **Mostly answered** | `task_started.task_id` = `tool_use_result.agentId` = `canUseTool.options.agentID` = `"a3268519e89ba2332"` (subagent t=4061, #50, #57). Background: `task_id` = TUR `agentId` = `"a7b260f0f9eaf2aee"` (subagent-background #34, #35). `output_file` = `/private/tmp/claude-<uid>/<encoded-cwd>/<session_id>/tasks/<task_id>.output`, which the async tool_result describes as "the full subagent JSONL transcript" (#35). Not directly observed: the `~/.claude/projects/…/subagents/agent-<id>.jsonl` name. Format: agent ids are `a` + 16 hex; Bash ids are `b` + 8 base-36 (`bblqdt0o5`, `b16gy4sc4`). Discriminate on `task_type`, not on the prefix. |
| 3 | ExitPlanMode `canUseTool` input; allow vs deny | **Deny answered; allow unknown** | Input is `{plan: <full markdown>, planFilePath: "<HOME>/.claude/plans/<slug>.md"}` (plan-review #234). The model sent `{}` (#233 `wire_tool_inputs`), so the CLI injects both fields, and the assistant frame's `message.content[].input` already carries them. Deny gives a tool_result `is_error:true` with the deny message (#239), `tool_result_meta.non_execution_kind:"permission-rule"`, and `result.permission_denials[]` with the full input (#345). The turn continues to `end_turn` (t=23542→29832). No mode-change frame was seen. Allow, and `deny{interrupt:true}`, were not recorded. |
| 4 | `SDKUserMessage.priority` semantics | **Unknown** | No scenario sends a second message. |
| 5 | `get_task_output` / `cancel_async_message` as Query methods | **Unknown** (not exercised) | The CLI wrote background output to `tasks/<id>.output`, and the model read it with `Read` (background-shell t=20945). ace can tail that file read-only instead of using `get_task_output`. |
| 6 | Does background completion start a full new turn unprompted? | **Answered: yes** (local_bash and local_agent) | `task_notification` → `init` → … → `result` with `origin.kind:"task-notification"` and `result_index` + 1 (background-shell t=18499→22426; subagent-background t=6947→9404). **No user frame** for the notification is forwarded, unlike claude-code.md §5.1. Gap between notification and init: 82 ms and 12 ms. |
| 7 | `forwardSubagentText` with partial messages | **Answered** | 0 `stream_event`s with non-null `parent_tool_use_id` in any fixture. Child text arrives as one complete `assistant` frame per block (subagent #54, subagent-background #51). Child frames: `tool_use` and `text` only, no `thinking` (unknown whether it is suppressed or the child just didn't think). Child frames carry `subagent_type` and `task_description` and lack `wire_tool_inputs`. |
| 8 | Background-subagent permission prompts never auto-deny | **Unknown** | The background child only used `Read` (auto-allowed). The foreground child's Bash prompt arrived via `canUseTool` with `agentID` (subagent #50). |
| 9 | Subscription-login policy | N/A (not a fixture question) | `init.apiKeySource:"none"` in every fixture means subscription OAuth was used. |
| — | Interrupt result and how the turn ends | **Answered for "interrupt while requesting"** | See §1 interrupt. `interrupt()` resolves `{still_queued:[]}` before the result. The synthetic user text `[Request interrupted by user]` comes next, then `result/error_during_execution` with `terminal_reason:"aborted_streaming"`. No `assistant.aborted` (no content had started). Interrupting a running tool (`aborted_tools`) was not captured. |
| — | Background Bash lifecycle | **Answered** | `bg[+id]` → `task_started{is_backgrounded:true, task_type:"local_bash"}` → tool_result "Command running in background with ID" with TUR `backgroundTaskId` → … → `bg[]` → `task_updated{completed,end_time}` → `task_notification{completed, summary with exit code}` → new turn. Not seen: `task_progress` and `tool_progress` for Bash; failure/kill paths; output streaming. |

---

## 3. Subagent tree

**Join keys (all observed at depth 1):**

```
root assistant tool_use{name:"Agent", id:U}      ── ToolCall item (kind agent.spawn), spawnedBy for the child
  └ system/task_started{task_id:T, tool_use_id:U, task_type:"local_agent", is_backgrounded, spawn_depth, subagent_type, prompt}
  └ child frames: assistant|user{parent_tool_use_id:U, subagent_type, task_description}
  └ canUseTool options{agentID:T, toolUseID:<child tool_use id>}
  └ system/task_progress{task_id:T, tool_use_id:U, description, last_tool_name, usage}
  └ system/task_updated{task_id:T, patch.status}        (no tool_use_id)
  └ system/task_notification{task_id:T, tool_use_id:U, status, summary, output_file, usage}
  └ root user tool_result{tool_use_id:U}, TUR.agentId = T   (foreground: final report; background: "async_launched")
background only: system/background_tasks_changed tasks[].task_id = T (ids only; no tool_use_id)
```

- **Routing:** `agentFor(frame) = frame.parent_tool_use_id == null ? root : agentBySpawnToolUse[parent_tool_use_id]`. For `canUseTool`, use `agentByNativeId[options.agentID] ?? root`. `task_updated` only has `task_id`.
- **Nesting:** only `spawn_depth:1` was recorded (`subagent_stats.max_depth:1, spawned_by_subagents:0`, subagent #100). Per docs, a grandchild's frames carry its spawner's (the child's) `Agent` tool_use id, and the recursive rule above handles that. **Unverified**; needs a depth-2 fixture.
- **Child transcript on the wire:**
  - Foreground: a `user` text frame with the prompt (subagent t=4064), then complete `assistant` frames (one per block: tool_use, text) and `user` tool_result frames. All `parent_tool_use_id:U`. No stream events, no thinking.
  - Background: **no prompt frame** (subagent-background t=5713 is the first child frame, a tool_use). Synthesize the child's first message from `task_started.prompt` and de-dup if a prompt frame does arrive.
  - The child's final text appears three times: the child `assistant` text, `task_notification.summary`, and (foreground) the root's `Agent` tool_result wrapped in `[Subagent hand-back] …`. Render it once, as the child's message. The root's tool_result is the ToolCall output.
- **Ordering hazards:**
  - The child's `canUseTool` arrives before the child's `tool_use` frame (subagent #50 → #52). Upsert the ToolCall from `toolUseID` and merge later.
  - `task_started` and the first child frame can precede the root's `message_stop` for the spawning message (subagent t=4061/4064 < 4068).
  - The level `bg[]` precedes `task_updated`/`task_notification` (subagent-background #52–54; background-shell #30–32).
  - Child `task_updated`/`task_notification` precede the root's `Agent` tool_result (subagent t=9555 < 9557).
- **Session id** is the root's on child frames too (subagent #46 `session_id` = root). It can't distinguish agents.

---

## 4. Status algorithm for the Claude adapter

The adapter emits facts; the daemon folds them (ADR 0004). Below, "adapter state" is per `Query` (one per ace thread).

### 4.1 Adapter state

```
turn: { active: bool, runId?, startedBy?: RunTrigger, lastResult? }
pendingWake: { since: t, tasks: task_id[] } | null      // out-of-turn bg completion awaiting its turn
sentSinceLastResult: bool                                 // ace wrote a user message since the last result
bgLevel: Map<task_id, {task_type, description, ambient}> // REPLACE on every background_tasks_changed
tasks: Map<task_id, {tool_use_id?, task_type, is_backgrounded, ownerAgentId, childAgentId?, status}>
agentBySpawnToolUse: Map<tool_use_id, AgentId>; agentByNativeId: Map<task_id, AgentId>
toolOwner: Map<tool_use_id, AgentId>                    // from tool_use frames (parent_tool_use_id) or canUseTool
openTools: Map<AgentId, Set<tool_use_id>>                // tool_use seen, tool_result not yet
openInteractions: Map<requestId, {agentId, toolUseId, interactionId}>
lastContent: Map<AgentId, "thinking"|"text"|"tool"|"requesting">
processAlive: bool; sessionState?: "idle"|"running"|"requires_action"  // only if EMIT env is set
```

### 4.2 Frame → fact rules

| Frame | Effect |
|---|---|
| `system/init` | If `!turn.active`, start a root Run. Trigger: `user` if `sentSinceLastResult`; else `subagent_result` if `pendingWake` holds a `local_agent` task; else `background_completion` if `pendingWake`; else `unknown`. Clear `pendingWake` and `sentSinceLastResult`. Root becomes `working{starting_turn}`. |
| `system/status{requesting}` | Root only (never seen for children). Root `working{starting_turn}` before the first content of the turn, else `working{thinking}` (waiting on the model). |
| `stream_event` content_block_start `thinking` / `system/thinking_tokens` | root `working{thinking}` |
| `stream_event` content_block_start `text` | root `working{responding}` |
| `assistant` tool_use (any agent) | Upsert ToolCall; add to `openTools[agent]`; set `toolOwner`. If name is `Agent`/`Task`: create the child Agent now (`starting`, `spawnedBy` = item, `background` = `input.run_in_background === true`) and set `agentBySpawnToolUse[id]`. Agent `working{tool, itemId}`. |
| `assistant` text (child) | child `working{responding}`. Children have no stream; default them to `working{thinking}` between frames. |
| `user` tool_result | Close the ToolCall: `succeeded`; `failed` on `is_error`; `declined` if `tool_result_meta[].non_execution_kind == "permission-rule"`. Remove from `openTools`. |
| `canUseTool` | Open an Interaction (kind per §4.5) on `agentByNativeId[agentID] ?? root`, with `toolCallId` from `toolUseID` (upsert the ToolCall as `awaiting_approval` if unseen). |
| `canUseTool` signal abort / `control_cancel_request` | Interaction `cancelled`. Not observed. |
| `system/task_started` | Upsert `tasks[task_id]`. Owner = `toolOwner[tool_use_id]`. `local_agent`: bind the child, set `agent.native.nativeId = task_id` and status `working`. If `is_backgrounded`, start a BackgroundTask (`kind: local_agent→subagent, local_bash→shell, monitor→monitor, else other`, `stoppable: true`). |
| `system/background_tasks_changed` | Replace `bgLevel`. Ids new to the level without an edge yet get a placeholder BackgroundTask. Ids that left the level without a terminal edge after 1 s become BackgroundTask `unknown`. |
| `system/task_progress` | Child `working{tool}`; keep `description` as the activity title. Add usage. |
| `system/task_updated{patch.status}` | `completed` → task completed and child `idle`. `failed` → `failed{provider, patch.error}`. `killed` → task `stopped`, child `interrupted`. `paused` → see §5. |
| `system/task_notification` | Final status (`completed`/`failed`/`stopped`) and endedAt. If the task was backgrounded and `!turn.active`, set **`pendingWake`** (subagent-background t=6947, background-shell t=18499). If `turn.active`, set `pendingWake` with a deadline anchored at the next `result` (it may be folded into the current turn; unverified). |
| `result` | End the root Run: `interrupted` if `terminal_reason` starts with `aborted_`; else `failed` if `is_error`; else `completed`. Correct the Run trigger from `result.origin.kind` (`task-notification` → background; absent → user). `turn.active = false`. Ignore `stop_reason` on aborted results (stale `"tool_use"`, interrupt #41). |
| `user` text `[Request interrupted by user]` (parent null, no origin) | Notice item (info). Not a user message. |
| process exit | Every open Interaction → `expired`; every running BackgroundTask → `unknown` (interrupt fixture shows a task can be live at close); every non-terminal agent → `failed{process_exit}` unless ace closed it deliberately. Reset `bgLevel` to ∅ on restart (d.ts:3703). |
| `session_state_changed` (only with the env var) | Store as `sessionState`. Used only as an extra AND-condition for idle (§4.4). |

### 4.3 Per-agent status (first matching rule wins)

Root agent:
1. `!processAlive` and not deliberately closed → `failed{process_exit}`.
2. Open blocking interaction owned by root → `blocked{human, refs:[interactionIds]}`.
3. `turn.active`:
   1. API retry or rate-limit rejection → `blocked{rate_limit|network}`. Not observed.
   2. A foreground `Agent` tool_use is open in `openTools[root]` and its child is non-terminal → `blocked{subagents, refs:[childIds]}` (subagent t=4061–9557).
   3. Other tool open → `working{tool, itemId}`.
   4. Else `working{lastContent}` (`starting_turn` until the first content of the turn).
4. `!turn.active`:
   1. `pendingWake` → `working{starting_turn}`. This covers the 12–82 ms gap; release after a 5 s grace with no `init`.
   2. Root-owned non-ambient live background tasks → `blocked{background_task, refs:[taskIds]}` (background-shell t=4211–18499; interrupt t=12916→end).
   3. Last result aborted → `interrupted`.
   4. Last result `is_error` (not aborted) → `failed{provider}`.
   5. Else `idle`.

Child agent (`local_agent`):
1. Terminal from `task_updated`/`task_notification` → `idle` / `failed` / `interrupted`. Done.
2. Open interaction with `agentID` = child → `blocked{human}`.
3. Open foreground `Agent` tool_use with a live grandchild → `blocked{subagents}`.
4. Open tool → `working{tool}`. Else `working{responding|thinking}`.
5. Child-owned background tasks after its own end are not observed. Treat them as still blocking the thread.

Precedence note: `interrupted` is reported only when nothing is live. After the interrupt fixture's turn ended, the root must show `blocked{background_task}` because `b16gy4sc4` is still running.

### 4.4 Thread "done" (Claude)

```
done ⇔ processAlive (or deliberately closed)
     ∧ !turn.active ∧ pendingWake == null
     ∧ openInteractions == ∅
     ∧ { t ∈ bgLevel | !t.ambient } == ∅
     ∧ every child agent terminal
     ∧ ace send-queue empty ∧ lastResult.queued_turn_count == 0
     ∧ (sessionState undefined ∨ sessionState == "idle")
```

Checks against the fixtures:

| Fixture | Done from |
|---|---|
| tool-read | t=4912 |
| approval-edit | 7006 |
| question | 4963 |
| plan-review | 29832 |
| subagent | 12091 |
| subagent-background | **not** at 4418 (bgLevel non-empty), not at 6947 (pendingWake); done at 9404 |
| background-shell | not at 4211; not at 18499; done at 22426 |
| interrupt | **never done** within the recording (bg task live) |

**Liveness:** the longest silent in-turn gap observed is 5.2 s (interrupt t=4919→10137, waiting for the first token), and the longest for a working child is 2.4 s (subagent t=7151→9532). Outside a turn there can be ≥14 s with zero frames while a background task runs (background-shell t=4211→18499). Run the `unresponsive` timer only while `turn.active` or a child is working, with a threshold ≥ 60 s. Never run it in `blocked{background_task}` or `blocked{human}`.

### 4.5 Interaction mapping (observed shapes)

- **Approval** (Edit, Bash, …):
  - `title` is absent in 2.1.286. Build it from `displayName` + `description` (approval-edit #57).
  - Options: `allow_once`, `deny`, plus one `allow_session` per `suggestions[]` entry (e.g. `setMode acceptEdits/session`). Allow returns `{behavior:"allow", updatedInput}`.
  - `decisionReason` is a human-readable explanation (subagent #50).
- **Question** (`AskUserQuestion`):
  - Use the `Question.id` = question text and option ids = labels.
  - Claude expects `answers[questionText] = label` (string; multi-select format not recorded).
  - Flags: `blocking: true`, `requiresUserInteraction: true`.
- **Plan review** (`ExitPlanMode`):
  - Request: `markdown = input.plan`, `planPath = input.planFilePath`.
  - Reject → `{behavior:"deny", message: feedback}`. The agent keeps going (it doesn't stop).
  - Approve → allow, then `setPermissionMode`. Unverified.

---

## 5. Contradictions with claude-code.md, and protocol fit

### 5.1 claude-code.md corrections

1. **§TL;DR 1, §3, §5:** `session_state_changed` is filtered by the SDK unless `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set. The proposed idle algorithm (§5) depends on it and must use §4.4 above.
2. **§TL;DR 1 / §5.1:** background completion turns have **no `user` frame** with `origin.kind:"task-notification"`. The origin is on the **`result`** (`origin:{kind, producer:"session-task"}`).
3. **§4 "first subagent frame is a user message carrying its prompt":** true only for foreground subagents.
4. **§4 / §3 partial streaming:** `stream_event` never carries a non-null `parent_tool_use_id`, so children don't stream. `forwardSubagentText` gave child text but no child thinking.
5. **§3 `system/status`:** only `"requesting"` was ever seen, and only for root API calls. It is never cleared (`null`), so it isn't a turn or idle signal.
6. **§6 canUseTool opts:**
   - No `title`.
   - `requiresUserInteraction: true` is present on AskUserQuestion and ExitPlanMode as an SDK option.
   - `decisionReason` is a string.
7. **§3 tool_use input:**
   - `message.content[].input` is the CLI's **normalized** input: `cd <cwd> &&` stripped (plan-review #34), ExitPlanMode plan injected (#233).
   - The model's raw input is in the new `assistant.wire_tool_inputs[tool_use_id]`, plus `wire_ingest_context[tool_use_id].cwd`.
   - Display the normalized input; keep both in raw.
8. **§3 thinking:** thinking blocks have empty `thinking` text with a signature only (`stream_event.thinking_display:"updates"`). Only the `thinking_tokens` estimate is usable.
9. **§2 capabilities:** `init.capabilities` = `interrupt_receipt_v1, interrupt_cancel_queued_v1, msg_lifecycle_v1, sdk_mcp_tools_list_changed, sdk_mcp_manifests, mcp_read_resource_v1, mcp_tool_ui_meta_v1, ui_surface_v1`. `queued_notifications` is not present.
10. **Undocumented fields:**
    - `result`: `subagent_stats{spawned, requested{background,foreground,unset}, started_in_background, max_depth, spawned_by_subagents, completed, failed, killed{parent,user,system}, refused{depth_limit,concurrency_limit,budget}, by_type}`, `origin`, `errors[]` (on error results), `ttft_ms`, `ttft_stream_ms`, `first_content_frame_ms`, `time_to_request_ms`, `api_error_status`.
    - `user`: `tool_result_meta`.
    - `init`: `memory_paths`, `messaging_socket_path`, `view_mode`, `output_style`, `per_turn_effort_active`.
    - `subagent_stats` is a useful cross-check: `completed:0` at subagent-background #46 shows a child is still out.
11. **Behaviours not in the doc:**
    - The CLI blocks long foreground `sleep` chains (interrupt #17).
    - `ExitPlanMode` is a deferred tool loaded through `ToolSearch` (plan-review #224).
    - Plan mode writes the plan to `~/.claude/plans/` without a prompt (#215).
    - `Read` is auto-allowed in `default`.
    - `modelUsage` includes `claude-haiku-4-5` side calls in every fixture.
12. **`settingSources: []` does not isolate claude.ai MCP connectors.** `init.mcp_servers` lists four `source:"claudeai"` servers (tool-read #0), and every final answer mentions their auth state (e.g. tool-read #53), which pollutes the transcripts. ace should check whether `strictMcpConfig`/explicit `mcpServers` suppresses them (unverified).

### 5.2 Proposed packages/protocol changes

1. **`BackgroundTask.ambient: z.boolean().default(false)`.** Claude marks watcher and skip-transcript tasks `ambient` (d.ts:3716). Without this field the done-rule must either ignore them adapter-side or block forever. Optionally add **`outputPath: z.string().optional()`** (`task_notification.output_file`, TUR `outputFile`), so clients can tail output.
2. **Run trigger correction.** Claude reveals the real trigger only on `result.origin`, at run end. Add `trigger: RunTrigger.optional()` to the `run.ended` event (or add a `run.updated` event).
3. **`RunTrigger` add `"spawn"`** for a child agent's run started by its parent's `Agent` call. None of `user | subagent_result | …` fits, and `unknown` loses information. Consider `"agent_message"` for `SendMessage` resumes.
4. **`AgentStatus.working` add `title: z.string().optional()`**, filled from `task_progress.description` (e.g. "Running Count lines in all files under src"). Children have no stream, so this is the best activity text.
5. **Document, without a schema change, in `agent.ts`:** `interrupted` and `failed` apply only when no background task or child is live; otherwise `blocked{background_task|subagents}` wins (interrupt fixture). ThreadStatus folding treats `interrupted` as settled.
6. **Optional `Item.reasoning.redacted: boolean`.** Claude thinking text is empty; clients should render "thinking (N tokens)" from the estimate rather than an empty block.
7. **`usage.updated`:** child usage from `task_progress`/`task_notification` is `{total_tokens, tool_uses, duration_ms}` with no input/output split. Either make `inputTokens`/`outputTokens` optional and add `totalTokens`, or require adapters to sum child `assistant.message.usage`, which is present on child frames (subagent #52).

### 5.3 Fixture and recorder gaps (re-record before relying on these paths)

- Prompt send is not recorded as a `send` frame (claude.ts `singlePrompt`).
- **interrupt** never interrupts a running foreground tool, because the CLI blocks `sleep N && …`. Use a non-sleep long command such as `node -e "setTimeout(()=>console.log('done'),60000)"`.
- The recorder's settle check ignores live background tasks (interrupt t=21109 stop with `b16gy4sc4` live). Gate `settled` on an empty `background_tasks_changed` level.
- Missing scenarios:
  - `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` run (ordering of `session_state_changed`)
  - plan approve
  - `deny{interrupt:true}`
  - depth-2 subagents
  - a background subagent needing approval
  - `stopTask` on a background task and whether that wakes a turn
  - a background task completing **during** an active turn
  - mid-turn user send (steer/queue, `priority`)
  - a second user-triggered turn (to confirm `init` per user turn)
  - Monitor
  - rate limit / `api_retry`

## Addendum: round-2 recordings (2026-10-02)

`interrupt.jsonl` was re-recorded with a foreground `for … sleep 1` loop, because the CLI refuses long `sleep` commands. Sections 1 (interrupt) and 4 described the earlier recording.

- The `Bash` tool_use arrives at t=11647. ace sent the interrupt at t=19648, and `interrupt()` resolved at t=19652 with `{still_queued: []}`.
- The tool_result follows at t=19662 and `result/error_during_execution` at t=19667.
- Nothing arrives afterwards, and the foreground command did not outlive the interrupt.
