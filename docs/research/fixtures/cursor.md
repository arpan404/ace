# Cursor ACP fixtures: what the recordings show

Analysed 2026-10-02. Fixtures: `fixtures/cursor/2026.09.26-dd393fe/*.jsonl` (CLI `2026.09.26-dd393fe`, `agent acp`, driver `tools/recorder/src/providers/cursor.ts`). This is read-only analysis. Nothing was re-recorded.

Citations look like `subagent seq=92 t=31862`, where `seq` is the frame `seq` and `t` is ms since recorder start. "cursor.md" means `docs/research/providers/cursor.md`. A few claims come from the user's local Cursor state written by these same runs. Those are marked **[local]** and give a path.

Facts common to all 8 fixtures:

- `initialize` returns `sessionCapabilities:{list:{},subagents:{}}`, `loadSession:true` and `promptCapabilities.image:true` (every fixture, seq=1). So `_meta.subagents` is acknowledged.
- `session/new` returns `sessionId`, `modes` (agent/plan/ask), `models` and `configOptions` with `mode`, `model` (44 options), `context` (`model_config`), `reasoning_effort` (`thought_level`) and `fast` (`model_config`) (tool-read seq=3 t=2701).
- After `session/prompt`, `available_commands_update` arrives in about 600 ms and `session_info_update{title}` in about 0.2–1.2 s, both before any content (for example tool-read t=3400/3454 and subagent-background t=3620/4202). The title arrived before the prompt response in all 8 fixtures.
- No `stderr` lines in any fixture (the recorder captures stderr, `tools/recorder/src/jsonrpc.ts:30`). No `usage_update`, `user_message_chunk`, `config_option_update`, `session/request_permission`, `cursor/ask_question` or `cursor/update_todos` in any fixture. No `tool_call_update` with `status:"failed"`.
- Message and thought chunks carry no `messageId` and no `_meta`. The only update variants with `_meta` are `subagent_spawned` and `subagent_state_update`.
- **`toolCallId` contains a literal newline**: `"call-<uuid>-<n>\nfc_<uuid>_<m>"` (for example tool-read seq=25). `<n>` counts tool calls across the agent's turn (plan-review `-0` to `-6`). `fc_<uuid>` is shared by the calls from one model step, and `_<m>` indexes within that step. Treat it as an opaque string. Never use it raw in file names, URLs, log keys or ace `ItemId`s.
- Agent→client JSON-RPC ids start at `0` per process (plan-review seq=154 `id:0`, subagent seq=184 `id:0`).
- Process exit code 143 in every fixture comes from the recorder's own SIGTERM (`stop` note just before it), not from Cursor.

---

## 1. Per-scenario status-relevant sequence

Notation: `R` is the root session and `C` is a child session. Chunk runs are collapsed (`thought×N`).

### tool-read (root `4b1dccb9…`)

| t | frame |
| --- | --- |
| 2701 | → `session/prompt` id=3 |
| 7053–7055 | R thought×2, message×16 |
| 7418 | R `tool_call` kind=`read` status=`pending` title=`"Read File"` rawInput=`{}` (seq=25) |
| 7418 | R `tool_call_update` title=`"Read src/math.ts"` rawInput=`{path:<abs>}` locations (seq=26). No status field |
| 7419 | R `tool_call_update` `in_progress` (seq=27) |
| 11228 | R `tool_call_update` `completed` rawOutput=`{content:<file text>}` (seq=28) |
| 12451–12453 | R thought×3, message×27 |
| 12663 | ← prompt `{stopReason:"end_turn"}` (seq=59) |

### approval-edit (root `1f0aff48…`). No approval was requested.

| t | frame |
| --- | --- |
| 7484–11157 | Read: `pending "Read File" {}` → title/rawInput refresh → `in_progress` → `completed` (seq=34–37) |
| 13582 | R `tool_call` kind=`edit` `pending` title=`"Edit File"` rawInput=`{}` (seq=40) |
| 13582 | refresh title=``"Edit `<abs path>`"`` rawInput=`{path}` (seq=41) |
| 13583 | `in_progress` (seq=42) |
| 18348 | `completed`, `content:[{type:"diff",path,oldText:<full before>,newText:<full after>}]`, **no rawOutput** (seq=43) |
| 20366 | ← `end_turn` (seq=68) |

There was no `session/request_permission` between seq=42 and seq=43. The in-workspace edit was applied without asking. The workspace was not on the user's `Write(...)` allowlist **[local]** (`~/.cursor/cli-config.json`, `approvalMode:"allowlist"`). So under this config, in-workspace edits are not permission-gated at all. The scenario did not exercise approvals.

### question (root `bd62fbd1…`). No tool call was made.

| t | frame |
| --- | --- |
| 7389–9307 | R thought×5: "No tool exists to ask a multiple-choice question directly." |
| 15570–15917 | R message×30: "This session doesn't include a multiple-choice question tool…" |
| 16115 | ← `end_turn` (seq=42) |

In agent mode the model (`grok-4.7`) said it had no AskQuestion tool, so `cursor/ask_question` was never sent. The scenario did not exercise questions.

### plan-review (root `e5006586…`, mode=plan)

| t | frame |
| --- | --- |
| 2836 | → `session/set_mode{modeId:"plan"}` (seq=4) |
| 2838 | R `current_mode_update{currentModeId:"plan"}` (seq=5), **before** the set_mode response (seq=6) |
| 8190–12029 | 2 parallel tools: Find (`search`) and Read. **Completed out of order**: Read `-1` at seq=48 t=11956, Find `-0` at seq=49 t=12029. Find rawOutput `{totalFiles:4,truncated:false}` |
| 13739–17197 | 4 tools in flight at once (seq=55–66), completed seq=67–70 |
| 20549–29782 | thought×43, message×35 |
| 34560 | R `tool_call` kind=`other` `pending` title=`"Create Plan"` rawInput=`{_toolName:"createPlan"}` (seq=149) |
| 34561/34578 | refresh: title=`"Create Plan: Math input validation"`, rawInput `{_toolName,name,plan:""}` then `plan:<full md>` (seq=150–151) |
| 34582 | `in_progress` content=`[{type:"content",content:{type:"text",text:"Processing plan..."}}]` (seq=152) |
| 34584 | R `plan{entries:[{content,priority:"medium",status:"pending"}×2]}` (seq=153) |
| 34584 | ← **request** `cursor/create_plan` id=0 `{toolCallId,name,overview,plan,todos:[{id,content,status}],isProject:false,phases:[]}`. **No `sessionId`** (seq=154) |
| 34584 | → `{outcome:{outcome:"rejected",reason:"Plan recorded. Do not implement it."}}` (seq=155) |
| 34663 | R `tool_call_update` `completed`, **no rawOutput and no content**. The rejection is not reflected (seq=156) |
| 36190–38169 | thought×9, message×162 (restates the plan) |
| 38349 | ← `end_turn` (seq=328) |

### subagent (root `391a54dd…`, child `98bf4ed8…`)

| t | frame |
| --- | --- |
| 9978–20238 | R reads 2 skill files under `<HOME>/.cursor/skills` (outside the workspace, not gated) and 2 Finds (seq=34–54) |
| 31855 | R `tool_call` kind=`other` `pending` title=`"Task: Count src file lines"`, full rawInput `{_toolName:"task",prompt,description,subagentType:{unspecified:{}}}` in the **first** frame (seq=90) |
| 31857 | R Task `in_progress` (seq=91) |
| 31862 | R **`subagent_spawned`** `{subagentSessionId:"98bf4ed8…",name:"generalPurpose",task:<first 80 chars>,capabilities:{},_meta:{cursor:{toolCallId:<Task id>,agentId:"98bf4ed8…",model:"grok-4.7-high"}}}` (seq=92) |
| 37282–37813 | **C** thought×3, message×26 on `sessionId=98bf4ed8…` |
| 38807–43204 | **C** `tool_call` execute ``"`find src … wc -l`"`` → `in_progress` → `completed {exitCode:0,stdout,stderr}` (seq=122–124) |
| 44581–46948 | C thought×7, message×50 |
| 47198 | R **`subagent_state_update{state:"completed"}`** with the same `_meta` (seq=182) |
| 47311 | R Task `completed` rawOutput=`{durationMs:15416,isBackground:false}` (seq=183) |
| 47311 | ← **request** `cursor/task` id=0 `{toolCallId,description,prompt,subagentType:{custom:{unspecified:{}}},model:"grok-4.7-high",agentId:"171dba23…",durationMs:15416}` (seq=184) → `{}` |
| 48843–50584 | R thought×6, message×74 |
| 50766 | ← `end_turn` (seq=266) |

Root was silent for 15.3 s while the child worked (seq=182 gap, t=31862→47198).

### subagent-background (root `6afa821f…`, child `69cdd94e…`)

| t | frame |
| --- | --- |
| 13992 | R `tool_call` Task `pending` with full rawInput, then `in_progress` (seq=23–24) |
| 13996 | R `subagent_spawned` (child `69cdd94e…`, `_meta.cursor.agentId` = same id) (seq=25) |
| 14071 | R Task **`completed` rawOutput=`{durationMs:77,isBackground:true}`** (seq=26) |
| 14071 | ← `cursor/task` id=0, `agentId:"796a90c8…"` (≠ child id), `durationMs:77` (seq=27) → `{}` |
| 15790 | R thought×3, message×1 `"started"` |
| 19413–25044 | **C** thought, message, Read tool (`pending` → refresh → `in_progress` → `completed`, seq=48–51), message |
| 25209 | R `subagent_state_update{state:"completed"}` (seq=100) |
| 29532–30446 | R thought×9: "Checking whether any follow-up work is needed after the subagent completion…" (seq=101+) |
| 32273–32359 | R message×38 (the summary) |
| 32565 | ← **`end_turn` only now** (seq=148). Recorder then saw 30 s of silence |

### background-shell (root `2865fa26…`)

| t | frame |
| --- | --- |
| 9529 | R `tool_call` kind=`execute` `pending` title=``"`sleep 15 && echo finished`"`` rawInput=`{command}` (seq=25), then `in_progress` (seq=26) |
| 14160 | R `completed` rawOutput=`{exitCode:0,stdout:"",stderr:""}` (seq=27). Nothing marks it as background |
| 16008 | R message `"launched"` |
| 16262 | ← `end_turn` (seq=32) |
| 16262–46432 | **No frames at all** (seq=33 → seq=34 `stop` note) |

**[local]** `~/.cursor/projects/<cwd-slug>/terminals/986993.txt` (slug = realpath with `/` replaced by `-`) shows the shell's life: `started_at 05:48:34.755Z` (t≈12828), `status: succeeded`, `exit_code: 0`, `elapsed_ms: 16207`, `ended_at 05:48:50.962Z` (t≈29035), output `finished`. So the command was still running for **12.8 s after `end_turn`**, and its completion produced **no ACP frame** in the 17.4 s before the recorder stopped. The terminal id (986993) and pid appear nowhere in the fixture.

### interrupt (root `77804356…`)

| t | frame |
| --- | --- |
| 8110 | R `tool_call` execute ``"`sleep 60 && echo done`"`` `pending`, then `in_progress` (seq=26–27) |
| 8110–16112 | silence (8 s, shell output is not streamed) |
| 16112 | → `session/cancel` notification (seq=29) |
| 16115 | ← prompt `{stopReason:"cancelled"}`, 3 ms later (seq=30) |
| 16115–24260 | **no further frames**. The shell `tool_call` never gets a terminal update |

---

## 2. Open questions in cursor.md, and the recorded claims

| # | Question / claim | Verdict | Evidence |
| --- | --- | --- | --- |
| Q1 | Agent-initiated mode switch emits `current_mode_update`? | **Unknown**. No agent-initiated switch occurred. Client `set_mode` **does** emit it, before the response | plan-review seq=5 t=2838 vs seq=6 |
| Q2 | Background-shell completion after `end_turn` delivered over ACP? | **Partially answered: not while idle.** No frame for ≥17.4 s after the shell ended, with no prompt open. Delivery on the *next* prompt is still untested | background-shell seq=32→34. [local] terminals file `ended_at` t≈29035 |
| Q3 | sessionId of subagent shell/write approvals; concurrent pending permissions | **Unknown.** Zero permission requests in any fixture. The child shell `find …\|sort\|xargs wc` used allowlisted commands | subagent seq=122. [local] allowlist has `Shell(find)`, `Shell(sort)`, `Shell(xargs)`, `Shell(wc)` |
| Q4 | `disconnected` after cancel cascade | **Unknown.** Interrupt had no subagents | interrupt |
| Q5 | Error-string families | **Unknown.** No errors-as-text in any fixture (all `end_turn` texts are normal answers) | — |
| Q6 | Model catalogue / config payloads | **Partial.** `configOptions` ids `mode, model, context, reasoning_effort, fast` with categories `mode, model, model_config, thought_level`. Root `currentModelId:"grok-4.7"`, subagent `model:"grok-4.7-high"` (effort folded into the id). `list_available_models` and config-file rewrite untested | tool-read seq=3. subagent seq=92 |
| Q7 | `resume` produces `<agentId>.<n>` session | **Unknown** | — |
| Q8 | Server-side timeout on pending permission | **Unknown** | — |
| Q9 | RFD `subagent_update` / tool `name` adopted? | **Answered for this version: no.** Cursor still sends `subagent_spawned`/`subagent_state_update`, and tool frames have no `name` | subagent seq=92/182 |
| — | `subagent_spawned` on parent sessionId with `_meta.cursor.{toolCallId,agentId,model}` | **Confirmed.** Fields: `subagentSessionId, name, task, capabilities:{}, _meta.cursor.{toolCallId, agentId, model}`. `agentId === subagentSessionId` in both fixtures. `name` is the subagent *type* (`"generalPurpose"`), not the task description. **`task` is truncated to exactly 80 chars** | subagent seq=92. subagent-background seq=25 |
| — | Child updates stream on child sessionId | **Confirmed** | subagent seq≈93–181 on `98bf4ed8…`. subagent-background seq≈29–99 on `69cdd94e…` |
| — | `subagent_state_update` terminal-only | **Consistent.** Only `completed` seen, once per child, on the **parent** sessionId with the same `_meta` as spawn | subagent seq=182. subagent-background seq=100 |
| — | Prompt response held until subagents finish | **Confirmed, including background subagents.** The background Task completed at t=14071 and "started" was said at t=15790, but `end_turn` came at t=32565, after the child's terminal state (t=25209) and a root follow-up | subagent-background seq=26, 100, 148 |
| — | Subagent completions fed back as follow-up runs | **Confirmed in effect, no wire marker.** The root resumes 4.3 s after `subagent_state_update` with a new thought. No `user_message_chunk`, no new prompt and no boundary frame | subagent-background seq=100→101 |
| — | `cursor/task` sent when Task completes | **Confirmed**, in the same ms as the Task `completed` update. For background tasks that is at *spawn* (77 ms), not at child completion. **`cursor/task.agentId` ≠ `subagent_spawned.agentId`** (`171dba23…` vs `98bf4ed8…`; `796a90c8…` vs `69cdd94e…`). `subagentType` is `{custom:{unspecified:{}}}` in `cursor/task` but `{unspecified:{}}` in Task `rawInput` | subagent seq=183/184. subagent-background seq=26/27 |
| — | Interrupt → `cancelled` | **Confirmed**, 3 ms after `session/cancel`. **The running tool call is left `in_progress` forever** (cursor.md doesn't say this) | interrupt seq=27, 29, 30 |
| — | `tool_call_update` never `failed` | **Consistent** (0 occurrences), and **extended**: a *rejected* `cursor/create_plan` still yields `completed`, with no rawOutput marking the rejection | plan-review seq=155→156 |
| — | Plan review: `plan` update and "Create Plan" card with progress text, then `cursor/create_plan` | **Confirmed.** Order: tool_call (placeholder) → title/rawInput refresh (plan text streamed twice) → `in_progress` "Processing plan..." → `plan` update → `cursor/create_plan` request (all within 24 ms) → `completed` 79 ms after the answer | plan-review seq=149–156 |
| — | Shell output not streamed | **Confirmed.** No frames during 8 s of `sleep 60` | interrupt t=8110→16112 |
| — | Permissions cover write/edit | **Contradicted for in-workspace edits under `approvalMode:"allowlist"`.** The edit was applied with no request | approval-edit seq=40–43 |
| — | Transcripts at `agent-transcripts/<parentId>/subagents/<agentId>.jsonl` (cursor.md §1, §4) | **Contradicted for ACP.** ACP root sessions wrote **no** transcript. Each child wrote `agent-transcripts/<childAgentId>/<childAgentId>.jsonl` at top level, with model-facing tool names (`Shell{command,working_directory,description…}`, `Read{path}`) and `{"type":"turn_ended","status":"success"}` | [local] `~/.cursor/projects/<slug>/agent-transcripts/98bf4ed8…/98bf4ed8….jsonl`, `…/69cdd94e…/69cdd94e….jsonl`. Roots only have `~/.cursor/acp-sessions/<id>/` |

Neither the question nor the approval scenario exercised its feature (model tool availability and the user's allowlist). See §6 for re-recording advice.

---

## 3. Subagent tree linkage

| Link | Field | Evidence |
| --- | --- | --- |
| child session → parent session | the `params.sessionId` of the `session/update` that carries `subagent_spawned` | subagent seq=92 (`391a54dd…`) |
| child session id | `update.subagentSessionId`. Every later child frame has `params.sessionId` = this | subagent seq=92 vs seq=122 |
| child → spawning tool call | `update._meta.cursor.toolCallId` = the parent's Task `toolCallId` (exact string, newline included) | subagent seq=90 vs seq=92 |
| provider agent id | `update._meta.cursor.agentId`. Equal to `subagentSessionId` for fresh spawns (cursor.md: resumed runs become `<agentId>.<n>`, untested). Also the transcript dir name [local] | both fixtures |
| child model / type | `_meta.cursor.model`, `name` (type, e.g. `generalPurpose`) | seq=92 |
| child title / prompt | **Use the parent Task tool call**: `rawInput.description`, which is also `title` minus `"Task: "`, and `rawInput.prompt`. `subagent_spawned.task` is cut at 80 chars | seq=90 vs seq=92 |
| foreground vs background | Task `tool_call_update.rawOutput.isBackground` (only known when the Task completes: immediately for background, at child end for foreground) | subagent seq=183. subagent-background seq=26 |
| child terminal state | `subagent_state_update.subagentSessionId` + `state`, on the parent session | seq=182, seq=100 |
| `cursor/task.agentId` | **Do not use for linkage.** It is a different uuid from the child's id. Link `cursor/task` by `toolCallId` only | seq=184, seq=27 |
| `cursor/*` requests → agent | They carry `toolCallId` but **no `sessionId`**. Route them through a `toolCallId → sessionId` index built from `tool_call` frames | plan-review seq=154 |

Mapping to `Agent`: `native.nativeId = subagentSessionId`, `parentId = agent(params.sessionId)`, `spawnedBy = item(_meta.cursor.toolCallId)`, `origin = "provider_subagent"`, `fidelity = "full"`, `role = name`, `model = _meta.cursor.model`, `name = Task rawInput.description`, `background = rawOutput.isBackground`. Ordering seen: Task `tool_call` → Task `in_progress` → `subagent_spawned` (+4–7 ms) → child frames (+5.4 s) → `subagent_state_update` → (foreground) Task `completed` (+113 ms) → `cursor/task`. A background Task completes **before** the child's first frame (seq=26 t=14071 vs first child frame t=19413).

---

## 4. Status algorithm for the Cursor ACP adapter

### 4.1 Adapter state

```
Session  { acpId, agentId, parentAgentId | null, spawnToolCallId?,
           subState: null(root) | "running" | "completed" | "failed" | "cancelled" | "disconnected",
           tools: Map<toolCallId, { status: "pending"|"in_progress"|"done", spawnsChild?: acpId, startedAt }>,
           lastFrameAt, lastSignal: "none"|"thought"|"message"|"tool_done"|"wake" }
Root     { promptOpen, promptRpcId, lastStopReason?, lastSegmentText }
toolOwner: Map<toolCallId, acpId>
openRequests: Map<rpcId, { method, acpId, toolCallId?, interactionId }>
bgTasks: Map<childAcpId, BackgroundTaskId>
pendingSpawn: Map<toolCallId, { isBackground }>   // handles either arrival order
```

### 4.2 Frame → fact rules

1. `session/update` with unknown `sessionId`: create a provisional child of the root (`fidelity:"full"`, raw kept). Re-parent it when `subagent_spawned` arrives. This never happened in the fixtures, where spawn always came first.
2. `tool_call`: register `tools[id]` and `toolOwner[id]`. The kind may be a placeholder (`"Read File"`, `"Edit File"`, `"Find"`, `"Create Plan"`, `rawInput:{}`), so **re-classify on every `tool_call_update`** that carries `title`/`rawInput`. A refresh update has **no `status`**, so keep the previous one (tool-read seq=26).
3. `tool_call_update.status`: `in_progress` maps to ToolStatus `running`. `completed` maps to `succeeded`, unless `rawOutput.exitCode≠0`, `rawOutput.error`, `rawOutput.permissionDenied` (`failed`) or `rawOutput.rejected` (`declined`). For createPlan, take the status from **ace's own answer**: rejected → `declined`.
4. `subagent_spawned`: create the child Agent (§3). Set `tools[toolCallId].spawnsChild = subagentSessionId`, `subState = "running"`, status `starting`.
5. Task `completed` with `rawOutput.isBackground === true` while the child is still `running`: emit `background_task.started{kind:"subagent", agentId: parent, childAgentId, toolCallId, stoppable:false}` and set `agent.background = true`.
6. `subagent_state_update`: set `subState`. Set the child Agent `endedAt`. If a bg task exists, `background_task.updated` (`completed→completed`, `failed→failed`, `cancelled→stopped`, `disconnected→unknown`). If the parent's prompt is still open, set the parent's `lastSignal = "wake"` (see the run split below).
7. Requests: `session/request_permission` (owner = `params.sessionId`), `cursor/ask_question`, `cursor/create_plan` (owner = `toolOwner[toolCallId] ?? root`) open a **blocking Interaction**, and the owning tool becomes `awaiting_approval`. `cursor/task`, `cursor/update_todos` and `cursor/generate_image` are informational: answer `{}` at once, attach them to the tool call's raw data, and never open an Interaction.
8. `agent_thought_chunk` sets `lastSignal="thought"`. `agent_message_chunk` sets `"message"` and appends to `lastSegmentText`. Any `tool_call` resets `lastSegmentText`. A tool going `done` sets `"tool_done"`. Start a new message/reasoning Item whenever the chunk kind changes or a tool_call intervenes (chunks have no ids).
9. Prompt response: `promptOpen=false`, `lastStopReason`. On `cancelled`, every root and descendant tool still `pending|in_progress` becomes ToolStatus `cancelled` (interrupt seq=27 is never closed by Cursor). Every open Interaction is answered `{outcome:{outcome:"cancelled"}}` and closed `cancelled`. Children with `subState==="running"` stay as they are until their `subagent_state_update`. If none arrives within 12 s (cursor.md cancel cascade is 10 s), mark them `interrupted` and record a synthetic raw note. On `end_turn`, tools still open that don't spawn a live child become `cancelled` with error `"turn ended without completion"`. This was not observed, so it is defensive.
10. Process exit / stdout EOF: every non-final agent becomes `failed{process_exit}`, Interactions become `expired`, and bg tasks become `unknown`.

### 4.3 Per-agent status (evaluate in order, recompute on every fact)

```
status(A):
  if processDead and A not final           → failed{process_exit}
  if openInteractions(A) ≠ ∅               → blocked{human, refs: interactionIds}
  if A is child:
     completed → idle | failed → failed{provider, msg: last child text}
     cancelled → interrupted | disconnected → unresponsive{lastSignalAt: A.lastFrameAt}
     running   → active(A)
  if A is root and !promptOpen:
     lastStopReason == "cancelled"        → interrupted
     classifyErrorText(lastSegmentText)    → failed{kind}       // §4.5
     else                                  → idle
  else                                     → active(A)

active(A):
  live      = A.tools where status ∈ {pending, in_progress}
  ownWork   = live where !spawnsChild || child(spawnsChild).subState != "running"
  if ownWork ≠ ∅                           → working{tool, itemId: newest(ownWork)}
  fgKids    = children(A) running and not background
  if fgKids ≠ ∅                            → blocked{subagents, refs: fgKids}
  bgKids    = children(A) running and background
  if bgKids ≠ ∅ and A.lastSignal == "message"
                                           → blocked{background_task, refs: bgTaskIds}
  switch A.lastSignal: thought → working{thinking}; message → working{responding};
                       none|tool_done|wake → working{starting_turn}
```

This reproduces the fixtures:

- subagent: R is `working{tool}` at 31855, then `blocked{subagents}` from 31862 (the Task is in progress but spawns a running child) until 47198. Then `working{starting_turn}`, `working{responding}`, `idle` at 50766. C goes `starting` → `working{thinking|responding|tool}` → `idle` at 47198.
- subagent-background: R is `working` until "started" (15790), then `blocked{background_task}` (bg child live, last signal = message), then `working{starting_turn}` at 25209 (wake), `responding`, `idle` at 32565.
- interrupt: R is `working{tool}` 8110–16115, then `interrupted`. The shell tool becomes `cancelled`.
- plan-review: R is `blocked{human}` for the 0 ms the create_plan request was open, then `working`, then `idle`.

**Run split.** When a parent was `blocked{background_task}` and the fact `wake` arrives, emit `run.ended(current, completed)` and `run.started{trigger:"subagent_result"}`. Otherwise a session/prompt is one Run with `trigger:"user"` (or `"queue"`). If a background child finishes while the parent is still streaming, Cursor queues the completion internally and there is no visible boundary. Keep one run in that case.

**Unresponsive.** Silence is normal. The longest observed gaps are 8.0 s during a running shell with no streamed output (interrupt), 15.3 s on the root while a child works (subagent seq=182), 9.4 s on the root during a bg child (subagent-background seq=100), and 6.3 s of model latency (question seq=12). Only consider `unresponsive` when the prompt is open, A has no live tool, no open interaction and no running descendant, and **no frame from any session in A's subtree** for ≥ 90 s. Never time out a live `execute` tool on silence alone, because shell output is not streamed.

### 4.4 Thread "done"

```
done ⇔ !root.promptOpen
     ∧ ∀ agent in tree: status.state ∈ {idle, interrupted}      // failed ⇒ thread "failed"
     ∧ ∀ child: subState ≠ "running"
     ∧ no Interaction pending
     ∧ no BackgroundTask with status ∈ {running, unknown}
     ∧ client-side prompt queue empty                            // Capabilities.steer = false
     ∧ no live shell in the terminals side channel (§5.1)
```

Thread status precedence: `needs_you` (any pending interaction) > `working` (any agent working or blocked on subagents) > `waiting{background_task}` > `unresponsive` > `failed` > `done`.

### 4.5 Errors-as-text

There were no samples. Keep the cursor.md rule unchanged: only a final segment that starts with `"\n\nError: "` is an error. Nothing in these fixtures can be used to test the classifier.

---

## 5. Contradictions, gaps, proposed protocol changes

### 5.1 Background shells are invisible over ACP. This is a correctness gap for AGENTS.md priority 1

The background shell's tool call reports `completed {exitCode:0,stdout:"",stderr:""}` at t=14160 with no background flag (seq=27). That is identical to a fast command with no output. The process ran until t≈29035 [local], and nothing was sent when it ended. Under the current rules ace would show the thread as **done** while a shell was running.

Mitigation, which needs live verification: Cursor writes `~/.cursor/projects/<realpath-cwd with "/"→"-">/terminals/<id>.txt` with a YAML-ish header (`pid, cwd, command, title, status, started_at, running_for_ms`) and footer (`exit_code, elapsed_ms, ended_at`) [local]. The adapter can watch that directory. Each file whose status is not final becomes `BackgroundTask{kind:"shell", stoppable:false}`, matched to the tool call by `command` equality and `started_at` falling within the tool call's pending→completed window. Next step: record a fixture that snapshots this file while it is running, to learn its non-final `status` value.

### 5.2 Proposed `packages/protocol` changes

1. **`Capabilities.backgroundVisibility: "full" | "partial" | "none"`**, or a boolean `backgroundShellsVisible`. Cursor is `partial`: subagents are visible, shells are not. The UI can then qualify "done" (for example "done, background work not tracked") instead of overclaiming.
2. **`RunTrigger` add `"spawn"`.** A child agent's first run is started by its parent's Task tool. None of `user|background_completion|subagent_result|goal|queue|schedule` fits, and `unknown` loses information that is known.
3. **`InteractionRequest.plan_review` add `title?: string`, `summary?: string`, `todos?: TodoEntry[]`.** `cursor/create_plan` sends `name`, `overview` and `todos[{id,content,status}]` (plan-review seq=154), and the todos have ids that the ACP `plan` update drops (seq=153).
4. **`ToolDetail` `plan` add `todos?: TodoEntry[]`**, so the createPlan tool card can hold the ACP `plan` entries (they arrive 2 ms before the request and belong to the same tool call).
5. **`InteractionResolution.question` add `skipped?: boolean`** (Cursor outcome `skipped{reason?}`). **`plan_review.decision` add `"cancel"`** (Cursor outcome `cancelled`). Without these, the adapter cannot represent valid Cursor outcomes. They also come from cursor.md §3a and were not exercised here.
6. **`NativeRef.aliases?: string[]`** (or `sessionIds`). The child's provider identity is `agentId`, and its live session id equals it today but changes to `<agentId>.<n>` on resume (cursor.md, untested). `cursor/task` also carries a third uuid. Keeping these as aliases lets resumed-subagent frames route to the same ace Agent. This is conditional on Q7.

`AgentStatus`, `BlockedReason`, `BackgroundTask`, `ToolStatus` and `Interaction.toolCallId` need no change. Everything observed fits once the adapter applies §4.

### 5.3 Other corrections to cursor.md

- Background subagents **do not** escape the prompt when `_meta.subagents` is set. The prompt is held (subagent-background seq=148). The "t3code failure mode" applies only without the capability.
- `subagent_spawned.task` is a truncated preview (80 chars). Use the Task `rawInput.prompt`.
- `cursor/task.agentId` is not the child id.
- Placeholder-then-refresh: `read`, `edit`, `search` and createPlan tool calls start with a generic title and `rawInput:{}`. `execute` and `task` start complete.
- Parallel tool calls on one agent: up to 4 in flight, completing out of order (plan-review seq=55–70, seq=48/49).
- `current_mode_update` precedes the `set_mode` response (plan-review seq=5/6).
- In-workspace edits did not trigger a permission request under `approvalMode:"allowlist"` (approval-edit).
- ACP root sessions write no `agent-transcripts`. Children write top-level `agent-transcripts/<childId>/<childId>.jsonl` [local].

### 5.4 Recovering tool identity (ToolKind)

There is no raw tool name on the wire. `rawInput._toolName` exists only for `task` and `createPlan`. Recovery, in order of precedence:

| Signal (fixture evidence) | ToolKind | Detail extraction |
| --- | --- | --- |
| `rawInput._toolName === "task"`, title `"Task: …"` (subagent seq=90) | `agent.spawn` | `description`, `prompt`, `agentType` = key of `subagentType` (`unspecified`), `childAgentId` from `subagent_spawned` |
| `rawInput._toolName === "createPlan"`, title `"Create Plan[: name]"` (plan-review seq=149–151) | `plan` | `markdown = rawInput.plan` |
| kind `execute`, `rawInput.command`, title = command in backticks (interrupt seq=26) | `shell` | `command`, `exitCode`/`output` from `rawOutput.{exitCode,stdout,stderr}`. No cwd and no background flag on the wire (the transcript has `working_directory`, [local]) |
| kind `read`, `rawInput.path`, title `"Read <rel-or-abs path>"` (tool-read seq=26) | `file.read` | `path`. Result `rawOutput.content` |
| kind `edit`, `rawInput.path`, completion `content[type=diff]` (approval-edit seq=43) | `file.edit` (`file.write` if `oldText` null/absent, untested) | `changes` from diff `{path,oldText,newText}`. No rawOutput |
| kind `search`, `rawInput.pattern`, title ``"Find `<glob>`"``, rawOutput `{totalFiles,truncated}` (plan-review seq=43/49) | `search` (glob) | `query = pattern`, `matches = totalFiles`. Grep per cursor.md would show `{totalMatches}` (not observed) |
| kind `other` / `think` / `fetch` / `switch_mode` without the above | `custom` (`web.fetch` for `fetch`, untested) | raw only |

Set `RawPayload.name` to `_toolName` when present and leave it unset otherwise. Don't invent names. The title prefix (`Read`, `Edit`, `Find`, `Task:`, `Create Plan`, backticked command) is stable enough to be a secondary signal, but it is presentation text. Key on `kind` + `rawInput` shape first.

---

## 6. Fixture gaps worth re-recording (needs the user's go-ahead; spends quota)

1. **Approvals.** Use a command not on the user's allowlist, or an edit outside the workspace. Nothing in the current set covers `session/request_permission`, Q3 or Q8.
2. **Question** in `plan` mode, or with a prompt naming `AskQuestion`. In agent mode the model said it had no such tool.
3. **Background shell with a follow-up prompt**, to see whether the completion is injected on the next turn (Q2), plus a snapshot of `terminals/*.txt` while it runs.
4. **Interrupt during a subagent**, for Q4 and the `cancelled|disconnected` timing relative to the prompt response.
5. **A failing tool** (`exitCode≠0`), to confirm `completed` + rawOutput rather than `failed`.
6. Recorder redaction: `subagent_spawned.task` leaks a truncated realpath (`/private/var/folders/5s/qdmf2wmx7`) because Cursor reports `/private/var/…` while the workspace is `/var/…`, and the truncation defeats the full-path match (subagent seq=92, subagent-background seq=25). `redact.ts` should also redact `realpath(workspace)` and its prefixes.

## Addendum: round-2 recordings (2026-10-02)

`interrupt.jsonl` was re-recorded with a foreground loop that prints a line every second.

- The shell tool call goes `in_progress` at t=9945, and `session/cancel` at t=17947 is answered with `stopReason: cancelled` at t=17950.
- As in round 1, the shell call never gets a final `tool_call_update`, and nothing shows whether the loop kept running. Treat the open call as `BackgroundTask{status: unknown}` (section 5.1 applies).
