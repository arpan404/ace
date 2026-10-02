# Codex fixture analysis (codex-cli 0.159.1)

Analysed 2026-10-02 from `fixtures/codex/0.159.1/*.jsonl` (recorded 2026-10-02 05:39–05:53 UTC, model `gpt-6.1-sol`, effort `medium`, `approvalPolicy: untrusted`, sandbox `workspace-write`, `experimentalApi: true`; driver `tools/recorder/src/providers/codex.ts`). It checks the claims in [`../providers/codex.md`](../providers/codex.md) against live traffic and maps them onto `packages/protocol`.

Citation format: `<scenario> t=<ms>` (ms since recording start) and `#<seq>`. Thread ids are shortened to their last 6 hex chars (`@900f70`). Each scenario is a single run (n=1), so treat ordering claims as "observed", not "guaranteed".

## 0. Cross-cutting facts

These held in every fixture.

- **Turn bracketing.** `thread/status/changed{active,[]}` comes right before `turn/started` in the same ms, and `thread/status/changed{idle}` comes right before `turn/completed` in the same ms (e.g. tool-read t=1348/1349 #14/#15, t=11097 #89/#90). `turn/start`'s JSON-RPC response arrives before `turn/started` (tool-read t=1240 #13 vs t=1349 #15).
- **Approval ordering**, `commandExecution`: `status{waitingOnApproval}` → `item/started` → server request → our response → `serverRequest/resolved` → `status{active,[]}` → `item/completed` (approval-edit t=7780–7846 #41–#47).
- **Approval ordering**, `fileChange`: here the `item/started` comes before the flag: `item/started` → `status{waitingOnApproval}` → request (approval-edit t=19457–19458 #84–#86).
- **Flags are aggregates, not per-request.** In tool-read, two parallel approvals (#46 id=0, #48 id=1) raised the flag once (#44) and cleared it once (#53), after both `serverRequest/resolved` arrived in reverse order (#51 id=1, #52 id=0).
- **Server request ids** are per connection and sequential across threads (subagent: id 0 is the root's at #62, ids 1 and 2 are the child's at #88/#99). Key interactions by `(connection, requestId)`. `serverRequest/resolved.requestId` matches.
- **No `emittedAtMs` on server requests.** Server requests and JSON-RPC responses lack it; notifications carry it (all 19 item-scoped server requests across fixtures).
- **Time units differ.** `turn.startedAt`/`completedAt` are Unix **seconds** (subagent #56 `startedAt: 1790920147`). `startedAtMs`, `completedAtMs` and `emittedAtMs` are ms.
- **`turn/completed.turn.items`** is `itemsView: "summary"` holding only the final `agentMessage` (subagent #184, #261). When there's no final agentMessage it's `notLoaded` with `[]` (plan-review #458, interrupt #52).
- **Item id shapes.** These matter for raw-name joins (§2 Q3):

  | Item                                                                                   | id shape                           | Evidence                       |
  | -------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------ |
  | `userMessage`                                                                          | UUIDv7                             | tool-read #20                  |
  | `agentMessage`                                                                         | `msg_…` (Responses item id)        | tool-read #22                  |
  | `reasoning`                                                                            | `rs_…`                             | approval-edit #57              |
  | `commandExecution` **and** `fileChange`                                                | `exec-<uuid>`                      | tool-read #45, approval-edit #84 |
  | async-question `agentMessage`, `subAgentActivity{started}`, `collabAgentToolCall{wait}`, `requestUserInput.itemId` | `call_…` (Responses `call_id`) | question #22, subagent #51/#96, plan-review #97 |
  | `plan`                                                                                 | `<turnId>-plan`                    | plan-review #114               |
  | `subAgentActivity{completed}`                                                          | `subagent-completed-<childTurnId>` | subagent #186                  |

- **`commandExecution` mutates between start and completion.** `processId` is `null` and `source` is `agent` on `item/started`. On `item/completed` they become `processId: "<n>"` and `source: "unifiedExecStartup"` (tool-read #45 → #54). Every command ran through unified exec. A non-zero exit gives `status: "failed"` (approval-edit #81, `rg` exit 1). That is a normal result, not a tool error.
- **`item/commandExecution/outputDelta` is not reliable.** It appeared only for the backgrounded command (background-shell #54). Every foreground command delivered output only in `aggregatedOutput` on completion.
- **Never observed:** `error`, `thread/closed`, `turn/plan/updated`, `item/fileChange/patchUpdated`, `item/commandExecution/terminalInteraction`, `functionCallOutput` items, `hook/*`, and `thread/started` for a child. A per-fixture method census was done with `jq`.
- **Environment contamination.** The recording machine's user-level skill `~/.agents/skills/unslop/SKILL.md` was read, with an approval, in tool-read, approval-edit, plan-review and subagent (e.g. tool-read #47). User MCP servers (`chrome-devtools`, `node_repl`, `cua_repl`, `codex_apps`) start per thread, **including child threads** (subagent #54). Fixtures therefore carry extra approvals and tool calls. The recorder should run with an isolated `CODEX_HOME` and skills dir, or the contract tests must tolerate them.

## 1. Per-scenario sequences

Only status-relevant frames are listed. Deltas, token usage, rate limits and MCP startup are omitted.

### tool-read (root @8360b7, turn …6b36f4)

| t | # | frame |
| --- | --- | --- |
| 1219 | 6, 8 | `thread/start` response, then `thread/started` (root only) |
| 1348/1349 | 14/15 | status active[] → `turn/started` |
| 2947 | 20/21 | `userMessage` started/completed |
| 4681–5561 | 22/43 | `agentMessage{commentary}` |
| 8162 | 44–48 | status `[waitingOnApproval]`; two parallel `commandExecution` started (`cat src/math.ts`, `cat …/unslop/SKILL.md`), requests id 0 and 1 |
| 8162–8163 | 49–53 | both accepted; `serverRequest/resolved` 1, 0; status active[] |
| 8232/8233 | 54/55 | both `commandExecution` completed (exit 0) |
| 10088–11047 | 58/86 | `agentMessage{final_answer}` |
| 11097 | 89/90 | status idle → `turn/completed{completed}` |

### approval-edit (@f3203f, turn …2cbfa7)

| t | # | frame |
| --- | --- | --- |
| 1000 | 14/15 | active → `turn/started` |
| 7780–7914 | 41–54 | two sequential command approval cycles (`cat src/math.ts`, then skill read) |
| 12518–12601 | 75–81 | approval for `rg --files …`, completed `status: failed` exit 1 |
| 19457 | 84 | `fileChange` started (diff already present, `kind: {type: update, move_path: null}`) |
| 19458 | 85/86 | status `[waitingOnApproval]`, `item/fileChange/requestApproval` id 3 (`reason: null`, `grantRoot: null`, no `availableDecisions`) |
| 19458–19480 | 87–90 | accept → resolved → active[] → `fileChange` completed |
| 19481 | 91 | `turn/diff/updated` (repeated at #101 and #138) |
| 19482–19558 | 92–98 | approval for `git diff`, completed |
| 23362–24415 | 102/135 | final answer |
| 24423 | 139/140 | idle → `turn/completed{completed}` |

All 17 command approvals across the fixtures offered exactly `availableDecisions: ["accept", {acceptWithExecpolicyAmendment}, "cancel"]`. There was no `decline` and no `acceptForSession` under `untrusted` (e.g. approval-edit #43).

### question (@a29714, turn …42c6df)

| t | # | frame |
| --- | --- | --- |
| 970 | 14/15 | active → `turn/started` |
| 6037 | 22/23 | `agentMessage` started and completed in the same ms: `id: call_FYBIX…`, `phase: "final_answer"`, `delivery: "async"`, `questions: [{title, options: ["Tabs","Spaces"]}]`, no deltas |
| 6037 | 25 | **we** send `turn/steer{expectedTurnId: …42c6df, input: "Tabs"}` |
| 6042 | 26 | steer response `{turnId: …42c6df}` |
| 6073 | 27 | token usage for the sampling that produced the question (the stream was still open when the steer landed) |
| 6074/6075 | 29/30 | `userMessage{clientId: null, content: "Tabs"}` in the **same** turn |
| 7808–8004 | 31/36 | final answer "You prefer Tabs." |
| 8050 | 39/40 | idle → `turn/completed{completed}` |

No `thread/status/changed` flag at any point: only 2 status frames, t=970 and t=8050. No server request.

### plan-review (@ff6f5d, turn …28c83a, `collaborationMode: plan`)

| t | # | frame |
| --- | --- | --- |
| 1109 | 13 | `thread/settings/updated` with `collaborationMode{mode: plan, developer_instructions: "# Plan Mode (Conversational)…"}`. The per-turn override is persisted on the thread. |
| 1171 | 15/16 | active → `turn/started` |
| 9106–26572 | 62–111 | five command approval cycles (exploration) |
| 22785 | 96/97 | status `[waitingOnUserInput]`; **blocking** `item/tool/requestUserInput` id 4, `itemId: call_DB4D…`, 2 questions with `id`, `header`, `isOther: true`, option descriptions, `isBlocking: true`, `autoResolutionMs: null` |
| 22785–22786 | 98–100 | answer → resolved → active[] |
| 27978 | 114 | `plan` item started (`id: …28c83a-plan`, text "") |
| 28024–38701 | 115–453 | 339 `item/plan/delta` |
| 38701 | 454 | `plan` completed. Text is markdown with no `<proposed_plan>` tags. |
| 38723 | 457/458 | idle → `turn/completed{completed}` with `items: []`, `itemsView: notLoaded` |

`call_DB4D…` never appears as an item (grep count 1). After the plan there is no `agentMessage`, and no follow-up frames for the 10 s until stop (t=48897). The scenario's `planDecision: "reject"` was **not exercised**: the driver has no plan-review response, because plan review is client-side.

### interrupt (@85ccdc, turn …1c3490)

| t | # | frame |
| --- | --- | --- |
| 215 | 13/14 | active → `turn/started` |
| 5877 | 38–43 | approval cycle; `commandExecution exec-d1cbb2da` (`sleep 60 && echo done`) started and accepted |
| 7035 | 44 | token usage (first sampling closed) |
| 13879 | 46/47 | note `interrupt-sent`; `turn/interrupt{threadId, turnId}` |
| 13885 | 48 | token usage (a second sampling had been in flight) |
| 13891 | 50 | interrupt response `{}` |
| 13891 | 51/52 | idle → `turn/completed{status: interrupted, error: null}` |
| 22059 | 55 | stderr: `codex_core::tools::router error=write_stdin failed: Unknown process id 59432`, logged at shutdown |

`exec-d1cbb2da` **never got `item/completed`** before process exit at t=22076, 8.2 s after the interrupt. There was no `error` and no abort notification. Stderr shows a `write_stdin` (the model polling the unified-exec session) still in flight until shutdown. Whether the `sleep` process was killed by the interrupt is **unknown**: the recorder didn't call `thread/backgroundTerminals/list`.

### background-shell (@1cb006, turn …870431)

| t | # | frame |
| --- | --- | --- |
| 225 | 13/14 | active → `turn/started` |
| 8023 | 35–40 | approval cycle; `commandExecution exec-0b77a527` (`sleep 15 && echo finished`) started, `processId: null` |
| 10790–12197 | 43–48 | reasoning, then final answer "launched", while the command is still `inProgress` |
| 12290 | 51/52 | idle → `turn/completed{completed}` (exec item still open) |
| 23074 | 54 | `item/commandExecution/outputDelta "finished\n"` with **`turnId: …870431` (the completed turn)** |
| 23076 | 55 | `item/completed` with the same old `turnId`, `status: completed`, `exitCode: 0`, `durationMs: 14897`, `processId: "44555"` |
| 53251 | 56 | recorder stop after 30 s quiet |

There was no `thread/status/changed` and no `turn/started` after the command finished, so the model **never reported the output**, even though the prompt asked for it. The thread was `idle` for 10.8 s while the process ran.

### subagent (root @900f70 turn …a2da9e; child @e46e4d turn …186879)

| t | # | thread | frame |
| --- | --- | --- | --- |
| 349 | 13/14 | root | active → `turn/started` |
| 4401–5934 | 24/50 | root | commentary |
| 9507 | 51/52 | root | `subAgentActivity{kind: started, id: call_xQAh…, agentThreadId: …e46e4d, agentPath: "/root/count_src_lines"}` started and completed |
| 9510 | 53 | child | **first child frame:** `thread/status/changed{idle}` |
| 9510 | 54 | child | `mcpServer/startupStatus/updated` (child-scoped) |
| 9511 | 55/56 | child | active → `turn/started` (no child `userMessage` item ever arrives) |
| 12391–12456 | 60–66 | root | root's own approval cycle (skill read) |
| 15731–15807 | 86–92 | child | child approval cycle; status flag set on the **child only** (root shows no status frame) |
| 16252 | 96 | root | `collabAgentToolCall{tool: wait, status: inProgress, receiverThreadIds: [], agentsStates: {}}`; root status stays active[] |
| 35653–35747 | 97–103 | child | child approval cycle (python line counter) |
| 37926–40133 | 106/180 | child | child final answer (the result table) |
| 40199 | 183/184 | child | idle → `turn/completed{completed}`; summary items = the final `agentMessage` |
| 40199/40200 | 186/187 | root | `subAgentActivity{kind: completed, id: subagent-completed-<childTurnId>}` on the root's **current** turn …a2da9e |
| 40222 | 188 | root | `wait` completed, still with `receiverThreadIds: []` and `agentsStates: {}` |
| 42289–44248 | 191/257 | root | final answer using the child's result |
| 44286 | 260/261 | root | idle → `turn/completed{completed}` |

### subagent-background (root @a42ae3 turn …bc1c66; child @783f2f turn …7f04ee)

| t | # | thread | frame |
| --- | --- | --- | --- |
| 362 | 13/14 | root | active → `turn/started` |
| 7008 | 24 | root | `subAgentActivity{started, call_2QOh…, agentThreadId: …783f2f, agentPath: "/root/readme_summary"}` **item/started** |
| 7008 | 25 | child | child `thread/status/changed{idle}`, **interleaved between the spawn item's started and completed** |
| 7009 | 26 | root | spawn item `item/completed` |
| 7044 | 28/29 | child | active → `turn/started` |
| 8940–9021 | 33/35 | root | final answer "started" |
| 9062 | 38/39 | root | idle → `turn/completed{completed}`, **child still running** |
| 11294–11357 | 41–47 | child | child approval (`cat README.md`); root shows no status frame |
| 12996–14148 | 50/87 | child | child final answer |
| 14153 | 90/91 | child | idle → `turn/completed` |
| 14154/14155 | 93/94 | root | `subAgentActivity{completed}` stamped **`turnId: …bc1c66` (finished at t=9062)** |
| 44309 | 95 | — | stop after 30 s quiet. **No new root turn**, so the summary was never relayed. |

## 2. Open questions from codex.md

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Background terminal exit after `turn/completed`: which turnId, is a new turn started? | **Answered (n=1).** `outputDelta` plus `item/completed` carry the **original, already-completed** `turnId`. No new turn and no status change follow. | background-shell t=23074 #54, t=23076 #55; nothing until t=53251 |
| 2 | `waitingOnApproval` for MCP elicitations, dynamic tools, and child approvals on the parent | **Partial.** Child approvals set flags on the **child thread only**; the parent gets no status frame, whether it was waiting in `wait` (subagent t=15731 #86, t=35653 #97) or idle (subagent-background t=11294 #41). `requestUserInput` sets `waitingOnUserInput` (plan-review #96). MCP elicitation and dynamic tools were not exercised. | as cited |
| 3 | Does `commandExecution.id` equal the Responses `call_id`? | **Answered for the stream: no.** Command and fileChange ids are `exec-<uuid>`, while every other tool-derived id is `call_…`. Nothing in the stream carries the native tool name for exec or patch items (`exec_command` is only inferable from `source: unifiedExecStartup`). A rollout join remains unverified: rollout `path` is in the thread object, but rollout files weren't captured. | tool-read #45; question #22; subagent #51 |
| 4a | Does child shutdown produce `thread/closed` or a status change? | **Partial.** After its turn the child goes `idle` and stays loaded. No `thread/closed` came 14 s later (subagent, t=40199→54352) or 30 s later (subagent-background, t=14153→44309). `close_agent` was never called. | as cited |
| 4b | How many child events are buffered before the listener attaches? | **Partial.** Nothing visibly lost. The child's first frame was `status{idle}`, then `turn/started` 1 ms later. The child's initial-input `userMessage` **never appears**: it's either not emitted for V2 children or lost before attach, and we can't tell which. | subagent #53–#56; subagent-background #25–#29 |
| 4c | `thread/started` for spawned children? | **Answered: none** in 0.159.1. One `thread/started` per fixture, the root's. | method census |
| 4d | `thread_created` broadcast lag in practice | **Unknown.** Children attached in 2/2 runs. | — |
| — | Do child events arrive before the parent's spawn item? | **Not in these runs, but close.** Child events came after the spawn `item/started` both times. In subagent-background the first child frame arrived *between* spawn `item/started` and `item/completed` (t=7008 #24 → #25 → #26). The race is real and the margin is under 1 ms, so the adapter must still buffer unknown thread ids. | as cited |
| — | Multi-agent version | **V2.** No `collabAgentToolCall{spawnAgent}`; spawn surfaced as `subAgentActivity{started}` with `agentPath: /root/<task_name>`. `wait` still surfaces as `collabAgentToolCall{tool: wait}`, but with empty `receiverThreadIds` and `agentsStates`, so it can't tell you which children it waits on. | subagent #51, #96, #188 |
| — | How child completion reaches the parent | `subAgentActivity{kind: completed, agentThreadId, agentPath}` with item id `subagent-completed-<childTurnId>`, emitted right after the child's `turn/completed` (same ms). It's stamped with the parent's current turn if one is running, else the **stale** last turnId. It carries no result text; the result is the child's final `agentMessage`. | subagent #186; subagent-background #93 |
| — | Does the parent turn complete before children? | **Yes, when the model doesn't call `wait`** (subagent-background: root t=9062, child t=14153). With `wait`, the parent turn ends after the child (subagent: child t=40199, root t=44286). After a background child finishes, **no parent turn auto-starts** (30 s observed). | as cited |
| — | Interrupt sequence | `turn/interrupt` → (token usage flush) → response `{}` → `status{idle}` → `turn/completed{interrupted, error: null}`, all within 12 ms. The in-flight `commandExecution` is **left open forever**. | interrupt #47–#52 |
| — | Async question flow | `agentMessage{delivery: async, phase: final_answer, questions: [{title, options: string[]}]}` arrives as one started+completed pair with **no question ids, no option descriptions, no multiSelect/isOther**. No status flag. Answered by `turn/steer` → `userMessage` in the same turn. Unknown: what the turn does if no answer arrives. The recorder answered in 0 ms, so we can't say whether the model would end the turn or keep working. | question #22–#30 |
| — | Plan mode output | One `plan` item, streamed by `item/plan/delta`, final text on `item/completed`. No `<proposed_plan>` wrapper, no trailing agentMessage, empty turn summary. In plan mode the model used **blocking** `requestUserInput`, not the async question tool. `collaborationMode` persists on the thread (`thread/settings/updated`). | plan-review #13, #97, #114, #454, #458 |
| 5 | Two devices answering the same approval | Not exercised. | — |
| 6 | `turn/start` steering stability | Not exercised. `turn/steer` with `expectedTurnId` worked and returned `{turnId}`. | question #26 |
| 7 | Shared daemon | Not exercised. | — |

## 3. Subagent tree linkage (V2, as observed)

| Link | Field | Example |
| --- | --- | --- |
| child thread → parent thread | `subAgentActivity.agentThreadId` on an item whose notification `params.threadId` is the parent | subagent #51: parent `@900f70` → child `…e46e4d` |
| child → spawning item | that same `subAgentActivity{kind: started}` `item.id` (= the spawn tool's `call_id`) | `call_xQAhby3ePmanaFvJ0eBZDBAU` |
| child → spawning turn | notification `params.turnId` of the started item | `…a2da9e` |
| child completion → child turn | completed-item id suffix `subagent-completed-<childTurnId>` (also `agentThreadId`) | subagent #186 → child turn `…186879` |
| tree address | `agentPath` | `/root/count_src_lines`, `/root/readme_summary` |
| depth | not observed directly; derive `depth = agentPath.split("/").length - 2` (=1 here). `source.subAgent.thread_spawn.depth` and `parentThreadId` exist in the schema (`SubAgentSource.ts`) but no child `Thread` object was ever sent | — |
| name / role | not on the wire. `agentNickname` and `agentRole` would need `thread/read` on the child (unverified). Use the last `agentPath` segment as `name`. | — |
| child prompt | **not visible**: no child `userMessage`, and `subAgentActivity` has no prompt | — |
| wait → targets | not available (`receiverThreadIds: []`). Treat as "all non-idle children of this parent". | subagent #96 |

Every child-scoped frame carries `params.threadId = child`: status, turn, item, server requests, MCP startup and token usage.

## 4. Adapter algorithm (Codex → canonical facts)

### 4.1 State kept per Codex thread (= one ace Agent)

```
CodexAgentState {
  threadId; parentThreadId?; spawnItemId?; agentPath?
  discovered: "thread_start" | "spawn_item" | "unknown_thread"
  activeTurnId?            // set on turn/started, cleared on turn/completed
  turnHadItem: boolean     // reset on turn/started
  lastTurn?: {id, status: completed|interrupted|failed, error?}
  nativeStatus             // last thread/status/changed (idle|active{flags}|systemError|notLoaded)
  openItems: Map<itemId, {type, turnId, item}>   // item/started without item/completed, any turn
  openRequests: Map<requestId, {method, itemId?}> // server requests for this threadId
  pendingSynthetic: Set<InteractionId>            // async questions, plan reviews
  retry?: {kind: network|rate_limit, until?}      // from error{willRetry:true}, cleared on next delta/item
  lastFrameAt                                     // any frame with this threadId
  children: Set<threadId>
  unreportedChildResults: Set<childThreadId>      // subAgentActivity{completed} seen while this thread was idle
}
```

### 4.2 Frame handling

1. **Unknown `threadId`** on any thread-scoped notification or request: create a placeholder agent (`status: starting`, `discovered: unknown_thread`) and buffer its frames. Never drop them. Link it when a `subAgentActivity{started}` naming it arrives. If none arrives within ~2 s, call `thread/read{threadId}` and take `parentThreadId` / `source.subAgent.thread_spawn`.
2. **`subAgentActivity{started}`** on parent P with `agentThreadId` C:
   - Create C if it doesn't exist; otherwise adopt the placeholder: `parentId=P`, `origin=provider_subagent`, `fidelity=full`, `spawnedBy=item.id`, `name=last(agentPath)`.
   - Emit a parent `tool_call{kind: agent.spawn, status: succeeded, detail.childAgentId=C}`. Raw is the `subAgentActivity` item; there's no native tool name.
   - Create `BackgroundTask{kind: subagent, agentId: P, childAgentId: C, toolCallId: item.id, status: running, stoppable: true}` (stop = `turn/interrupt` on C's active turn). It's `background=false` until P's turn ends while C isn't idle; then set `Agent.background=true`.
3. **`subAgentActivity{completed}`**: no status change by itself (C's own `turn/completed` is authoritative and arrives first). Emit a synthetic parent notice item ("<name> finished"). If P has no `activeTurnId`, add C to `P.unreportedChildResults`. Don't trust the item's `turnId` for run attribution; it can name a finished turn.
4. **`turn/started`**: set `activeTurnId`, open a Run. Trigger:
   - `user` if it matches an outstanding ace `turn/start` (correlate by our request id: the response carries the same `turn.id`).
   - Otherwise, for a child: the parent's spawn, `followupTask` or `sendInput` → see §5 proposal 1.
   - Otherwise `subagent_result` if `unreportedChildResults` is non-empty; else `background_completion` if a background `commandExecution` completed since the last turn; else `goal` / `queue` if `thread/goal/*` or `thread/queue/changed` was seen; else `unknown`.
   - Clear `unreportedChildResults`.
5. **`item/started`**: put the item in `openItems`. Its activity: `reasoning`→thinking, `agentMessage`/`plan`→responding, `contextCompaction`→compacting, others→tool. Then:
   - `agentMessage{delivery: async, questions≠null}`: open `Interaction{kind: question, blocking: false, toolCallId: item.id}`. Question ids are synthesized as `q<index>`; `text = title`; option `id = label = string`; `allowOther: true`; `multiSelect: false`. **Don't treat its `phase: final_answer` as the end of the turn.**
   - `plan`: start the plan item; deltas from `item/plan/delta`.
6. **`item/completed`**: remove from `openItems`. Look the item up by id, not by `turnId`; late completions carry stale turnIds. A `commandExecution` with a `BackgroundTask` → `background_task.updated{completed|failed}`.
7. **Server requests** (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`): open `Interaction{blocking: true, toolCallId: params.itemId}`.
   - `requestUserInput.itemId` is a `call_…` id with no item behind it, so synthesize a `tool_call{kind: ask_user}` item with that id.
   - Options come from `availableDecisions` when present (`accept`→allow_once, `acceptForSession`→allow_session, `acceptWithExecpolicyAmendment`→allow_always, `decline`→deny, `cancel`→cancel). Otherwise use the full enum (fileChange).
   - Close on `serverRequest/resolved` (`resolved`). On `turn/completed` with the request still open, close it `cancelled`. On process exit, close it `expired`.
8. **`turn/completed`**: close the Run (`completed|interrupted|failed`), set `lastTurn`, clear `activeTurnId`. Then reconcile `openItems` belonging to that turn:
   - `commandExecution`, turn `completed` → it's a background shell: `BackgroundTask{kind: shell, toolCallId: itemId, status: running, stoppable: true}`. The tool call stays `running` with `backgroundTaskId`. To stop it, `thread/backgroundTerminals/list` → match `ThreadBackgroundTerminal.itemId` → `terminate{processId}`. You can't skip the list: `processId` is null until completion.
   - `commandExecution`, turn `interrupted` → call `thread/backgroundTerminals/list` (unverified). If the itemId is listed, create a shell task as above. If not, or the call fails, mark the tool call `cancelled`. Don't wait for an `item/completed` that never comes (interrupt #52).
   - Every other open item type (`fileChange`, `collabAgentToolCall`, `mcpToolCall`, `agentMessage`, `plan`, …) → mark it `cancelled` (interrupted or failed turn) or `succeeded` (completed turn).
   - Open synthetic async questions stay `pending` (now effectively blocking: see 4.4).
   - If the turn ran with `collaborationMode: plan` and produced a completed `plan` item → open `Interaction{kind: plan_review, blocking: true, markdown: plan.text}`. Resolve approve → `turn/start{collaborationMode: default, input: "Implement the plan."}`; reject → close it and send the feedback, if any, as a plan-mode `turn/start`.
9. **`thread/status/changed`**: use it as a cross-check only. A flag with no open request means an unknown request type: show `blocked{human}` with no refs. `systemError` → `failed{provider}`.
10. **`error{willRetry:true}`** → set `retry` (`rate_limit` if `codexErrorInfo` is in `rateLimitExceeded|serverOverloaded|usageLimitExceeded`, else `network`). Clear it on the next delta or item. Not observed in the fixtures.

### 4.3 Per-agent `AgentStatus` (evaluate in order)

1. App-server process gone → `failed{process_exit}` for every agent with an active turn or live task.
2. `activeTurnId` set:
   1. any `openRequests` → `blocked{human, refs: interactionIds}`
   2. `retry` → `blocked{rate_limit|network, until}`
   3. open `collabAgentToolCall{tool: wait}` → `blocked{subagents, refs: non-idle children}`
   4. latest open item → `working{activity, itemId}`. With no open item: `working{starting_turn}` before the first item of the turn, `working{thinking}` after.
   5. if no frame for N s and the open item isn't a long-runner (`commandExecution`, `wait`, `sleep`) → `unresponsive{lastSignalAt}`
3. No active turn:
   1. never had a turn (spawned or placeholder) → `starting`
   2. `lastTurn.status == failed` → `failed{…}`
   3. any owned `BackgroundTask` running (shell, or subagent child not idle) → `blocked{background_task, refs}`
   4. `lastTurn.status == interrupted` → `interrupted`
   5. otherwise → `idle`

An open **non-blocking** async question doesn't change the agent's status. The agent stays `working` while its turn runs. After the turn ends it is `idle`, and the question is what keeps the thread from being done.

### 4.4 Thread "done" (Codex)

The thread is `done` iff all of the following hold:

- Every agent in the tree (root, every child from `subAgentActivity`, every placeholder from unknown ids) has no `activeTurnId`, has had at least one completed turn (no `starting` agents), and has `nativeStatus = idle|notLoaded`.
- No open server request on any agent.
- No pending synthetic interaction (async question, plan review) in any state but resolved, cancelled or expired.
- No `BackgroundTask` with `running` status (shell or subagent).
- No input queued in ace.
- **Belt-and-braces:** when the fold first reaches "done", call `thread/loaded/list` (and/or `thread/list{ancestorThreadId: root}`) once. Any loaded descendant not in the tree gets added and `thread/read`; if it isn't idle, the thread isn't done. This covers the broadcast-lag case where a child is never attached (codex.md §4).

`ThreadStatus` precedence:
1. `needs_you`: any open blocking interaction, or a non-blocking one whose agent isn't working.
2. `working`: any agent `starting`, `working` or `blocked{subagents}`.
3. `waiting{background_task|rate_limit|network|queue}`.
4. `unresponsive`.
5. `failed`: root's last turn failed and nothing else is live.
6. `done`.

### 4.5 Edge cases seen in the data

- Parent `idle` with a running child: subagent-background t=9062–14153 → thread `working` while the child is active; the parent is `blocked{background_task}`, never thread `done`. This follows the working-first thread precedence above and the owner integration rule.
- Parent `idle` with a running shell: background-shell t=12290–23076 → `waiting{background_task}`.
- Late `item/completed` and `subAgentActivity{completed}` with a stale `turnId` (background-shell #55, subagent-background #93). Attribute by item id or child thread, never by the turn. The item's Run is already ended.
- An interrupted turn leaves an open `commandExecution` with no completion (interrupt #52). If it's not reconciled, the thread never reaches `done`.
- Parallel approvals with one aggregate flag change (tool-read #44–#53).
- A `fileChange` item starts **before** its approval flag. A `commandExecution` starts **after** it.
- The async question is a `final_answer`-phase message mid-turn (question #22).
- `requestUserInput.itemId` references no item (plan-review #97).
- The child's first frame is `status{idle}`, not `active`. Don't read that as "child done": it hasn't had a turn yet, so it's `starting`.
- A background child result never wakes the parent (subagent-background, 30 s). `done` is correct here, but surface "unread subagent result" (`unreportedChildResults`) so the user can prompt a follow-up.
- `turn.startedAt` is in seconds; `*AtMs` fields are in ms.

## 5. Contradictions with codex.md and protocol fit

### 5.1 Corrections and refinements to codex.md

1. **§4 V2 spawn.** Confirmed, plus detail: the spawn `subAgentActivity` item id is the spawn tool's `call_id`, and the completed item id is `subagent-completed-<childTurnId>`, which codex.md doesn't mention. V2 still emits `collabAgentToolCall` for `wait`, with empty `receiverThreadIds` and `agentsStates`. The mapping "`blocked{subagents}` ← `collabAgentToolCall{tool: wait}`" holds, but the targets must come from the tree, not the item.
2. **§4 V2 completion.** "Queues the child result with `trigger_turn=false`" is consistent: no parent turn followed in 30 s. The completed item **is** delivered live on the parent's stale turn (confirmed).
3. **§5 background terminals.** Now verified. Add that `processId` is null on `item/started`, so mapping to `backgroundTerminals/list` must go through `ThreadBackgroundTerminal.itemId`.
4. **§7 interrupt.** Add that open `commandExecution` items aren't closed by the interrupt.
5. **§3 `commandExecution.source`.** It isn't stable across an item's lifetime (`agent` → `unifiedExecStartup`). Don't key anything on it from `item/started`.
6. **§6 / mapping "ask_user".** Which question mechanism the model uses depends on mode in this build: blocking `request_user_input` in plan mode, async `agentMessage` questions in default mode. Both must be supported.
7. **§3 `fileChange`.** `item/fileChange/patchUpdated` wasn't emitted for a single-shot patch; the full `changes` came on `item/started`. File change ids use the `exec-` prefix.
8. **Approval decisions** under `untrusted`: commands never offered `decline` or `acceptForSession`. The UI must render only `availableDecisions`.

### 5.2 Fit with `packages/protocol`, and proposed changes

1. **`RunTrigger` has no value for "started by the parent agent".**
   - Problem: a child's first turn (spawn), and turns from `followup_task` / `send_input`, are neither `user` nor `unknown`.
   - **Proposal:** add `"parent_agent"` to `RunTrigger` ("run requested by this agent's parent: spawn, follow-up or message").
2. **`Agent` can't hold the provider's tree address.**
   - Problem: V2 addresses agents by `agentPath`, and it's the only depth signal on the wire.
   - **Proposal:** add `path: z.string().optional()` to `Agent` ("provider's hierarchical address, e.g. Codex `/root/count_src_lines`"). The alternative is to extend `NativeRef` with `path`, keeping provider data together; that's preferable since it's native.
3. **`Interaction.toolCallId` may reference no item.**
   - Problem: `requestUserInput` has no backing item.
   - Fix without a schema change: the adapter synthesizes an `ask_user` tool_call item. Document this in ADR 0004 / the adapter contract: "an Interaction's `toolCallId` must reference an emitted item; adapters synthesize one if the provider has none".
4. **Non-blocking interactions and `ThreadStatus`.**
   - Problem: the schema can express them (`blocking: false`), but the ADR's rule "done only when no interaction is open" needs a stated precedence.
   - **Proposal:** document in ADR 0004 that `needs_you` counts blocking interactions, plus non-blocking ones whose agent has no active run. No schema change.
   - Resolution delivery differs by state (`turn/steer` while the turn runs, `turn/start` after), which is adapter-internal.
5. **Late items on ended runs.**
   - Problem: `item.updated` for an item whose `runId` refers to an ended run is normal for Codex (background shell, stale-turn `subAgentActivity`).
   - **Proposal:** state in `events.ts` docs that `item.created`/`item.updated` may follow `run.ended` for the same `runId`, and that clients must not treat `run.ended` as sealing the run's items.
6. **`BackgroundTask` for interrupted shells.**
   - Use `status: "unknown"` when `backgroundTerminals/list` can't confirm liveness. This fits as is, but the daemon must treat `unknown` as **not live** for `done`; otherwise an interrupted thread never settles.
   - **Proposal:** document that `unknown` is terminal for the done fold.
7. **`RawPayload.name`.** Codex exec and patch items have no native tool name. Leave `name` unset and keep the raw frames as `type: "commandExecution"` (`item/started`, `item/completed`, the approval request). No change needed, but codex.md's hope of a rollout join is unproven. Don't promise a raw tool name in the UI for Codex.
8. **Plan item.** `ToolDetail{kind: plan, markdown}` fits a Codex `plan` item mapped as a `tool_call` (raw type `plan`). No change needed.
9. **Capabilities for Codex** (from data plus codex.md): `steer: true` (question #26); `subagentTranscripts: true`, minus the child prompt; `backgroundTaskControl: true` (via the experimental list/terminate, unverified live); `interruptCascades: false` (codex.md; not exercised); `planMode: true`.

### 5.3 Gaps worth a follow-up recording (needs the user's go-ahead)

- An async question left unanswered: does the turn end, and does the late answer via `turn/start` work?
- An interrupt with `thread/backgroundTerminals/list` before and after, to learn whether the process survives.
- A plan-review reject and approve round-trip.
- An interrupt of a parent with a running child, to observe the non-cascade.
- A `thread/read` on a child, to capture `parentThreadId`, `source.subAgent.thread_spawn{depth, agent_nickname, agent_role}` and whether the child prompt is in history.
- An isolated `CODEX_HOME` / skills dir to remove the `unslop` and MCP noise.

## Addendum: round-2 recordings (2026-10-02)

`interrupt.jsonl` was re-recorded with a foreground loop that prints a line every second. The `interrupt` scenario in section 1 described the earlier recording.

- **An interrupt ends the turn but not the command.**
  - `turn/interrupt` at t=14492 is followed by `thread/status/changed idle` and `turn/completed{status: interrupted}` at t=14503.
  - The same `commandExecution` then keeps streaming `outputDelta` (t=14583, t=15591…) and a `terminalInteraction` (t=15424), and only sends `item/completed` at t=67107, 52 s later.
- Adapter rule: on `turn/completed{interrupted}`, every `commandExecution` of that turn without `item/completed` becomes a `BackgroundTask{kind: shell, status: running}`, so the agent shows `blocked{background_task}` until it completes. Offer `thread/backgroundTerminals/terminate`, and use it for `thread.interrupt` with `cascade: true`.
