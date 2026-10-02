# OpenCode 1.18.33: what the recorded fixtures show

Analysed 2026-10-02 from `fixtures/opencode/1.18.33/*.jsonl` (recorder driver `tools/recorder/src/providers/opencode.ts`, scenarios `tools/recorder/src/scenarios.ts`). No sessions were run for this analysis. Companion to [providers/opencode.md](../providers/opencode.md) (called "the research doc" below).

Citation format: `<fixture>#<seq> t=<ms>`. `seq` is the recorder frame number. In the file it is line `seq + 2`, because line 1 is the header. Session IDs are shortened to their last 6 characters. `retry-overloaded.jsonl` has `"scenario":"tool-read"` in its header: it is a tool-read run on the overloaded default model `muse-spark-1.3-contributor` (`retry-overloaded#18`).

---

## 0. Cross-cutting facts

| Fact | Evidence |
| --- | --- |
| Every session event, including child-session events, carries the same envelope `directory` (`<WORKSPACE>`) and `project` hash as the parent's. `project.updated` uses `directory:"global"`. `server.heartbeat` and `server.connected` have no envelope fields. No `workspace` field appears anywhere. | envelope census over all 9 files; e.g. `subagent#458` (child `session.created`, `directory:"<WORKSPACE>"`, `project:"09109f2e…"`) |
| No `session.next.*`, `todo.updated`, `retry` part, `subtask` part, `agent` part or `compaction` part was observed in any fixture. Part types seen: `text, reasoning, tool, step-start, step-finish, patch`. | part-type census, all files |
| `message.part.delta.field` is **always `"text"`**, for reasoning parts too (11,773 reasoning deltas and 359 text deltas, all `field:"text"`). The part type has to come from the earlier `message.part.updated` for that `partID`. That part always arrived first (0 deltas with an unknown part). | delta census, all files |
| Heartbeat every ~10 s, starting 10 s after connect. | `retry-overloaded#78 t=10495, #80 t=20497, #81 t=30498 …` |
| A turn is a sequence of assistant messages that share `parentID` = the prompting user message, one per LLM step. Each step: `step-start` … `step-finish{reason: tool-calls\|stop}` → assistant `message.updated` without `time.completed`, then again with `time.completed` → `session.status busy` → next assistant message. | `tool-read#110–#117 t=5625–5666`, `#171–#178` |
| Normal turn end: final assistant `message.updated{finish:"stop", time.completed}` → `session.status busy` → `session.status idle` → `session.idle` → `session.updated` → `session.diff`, all in the same millisecond. Then **~25–50 ms after idle, a trailing `message.updated` for the *user* message** (adds `summary.diffs`). | `tool-read#175–#184 t=7231→7258`. Same pattern in `approval-edit#194–#203`, `question#169–#178`, `subagent#906–#915`, `background-shell#9442–#9451` |
| `session.diff` was `diff:[]` even after a real edit. The diff showed up in the trailing user message's `summary.diffs` and in a `patch` part. | `approval-edit#202` (empty) vs `#203` (`summary.diffs[0].file:"src/math.ts"`), `#160` patch part |
| `busy` is re-emitted many times per turn (each step plus an extra ~45 ms later). Treat it as idempotent. | `tool-read#17, #74, #116, #122, #177` |
| Deleting a root session cascades: child `session.deleted` comes first, then the parent's. A later DELETE on the child returns 404. | `subagent#922, #924, #926 t=38859–38861`; `subagent-background#637–#641` |

## 1. Per-scenario status sequences

`@x` = session. P = parent/root, C = child. Deltas, sync twins and noise are omitted.

### tool-read (`tool-read.jsonl`)
`#5 t=595` POST prompt_async → `#6 t=596` session.created P (no parentID) → `#11 t=627` user msg → `#17 t=1244` **busy** → `#18` assistant msg 1 → `#75 t=4533` step-start → reasoning → `#104 t=4846` tool:read pending → `#106 t=5568` running → `#108 t=5575` completed → `#110 t=5625` step-finish(tool-calls) → `#114 t=5666` msg1 completed → `#116` busy → `#117` assistant msg 2 → reasoning, text → `#171 t=7186` step-finish(stop) → `#175 t=7231` msg2 completed → `#177` busy → `#178 t=7231` **idle** → `#180` session.idle → `#184 t=7258` trailing user message.updated.

Gap prompt→busy ≈ 650 ms. Gap busy→first part ≈ 3.3 s with nothing but `busy` (`#17→#75`).

### approval-edit
Same shape. Step 2: `#142 t=6598` tool:edit pending → `#144 t=8062` running → `#146 t=8063` **permission.asked** `{id:per_…, permission:"edit", patterns:["src/math.ts"], always:["*"], tool:{messageID, callID}}` → `#149 t=8070` permission.replied `{sessionID, requestID, reply:"once"}` → `#152` running + `metadata.diff` → `#154` completed (`metadata.diagnostics, diff, filediff`) → `#156 t=8151` step-finish → `#160 t=8214` **patch** part `{hash, files[]}` → … `#197 t=9359` idle. Interaction round trip took 7 ms. The status stayed `busy` while the approval was open (no status frame between `#144` and `#164`).

### question
`#110 t=4960` tool:question pending (input not streamed, 813 ms) → `#112 t=5773` **question.asked** `{id:que_…, sessionID, questions:[{question, header, options:[{label, description}]}], tool:{messageID, callID}}`. **No `multiple`/`custom` keys** → `#114 t=5774` tool part running (**after** asked) → `#117 t=5780` question.replied `{sessionID, requestID, answers:[["Tabs"]]}` → `#118` completed `metadata.answers` → … `#172 t=7279` idle.

### plan-review (agent `plan`, `OPENCODE_EXPERIMENTAL_PLAN_MODE=1`)
`#11` user msg `agent:"plan"` → `#17 t=1241` busy → `#18 t=1244` **second text part on the *user* message, `synthetic:true`**: a `<system-reminder>` containing the plan-file path `<WORKSPACE>/.opencode/plans/<ts>-<slug>.md` and the instruction "call plan_exit … Do NOT use question tool to ask 'Is this plan okay?'". The plan agent then runs 4 steps of read/glob/bash. `#805 t=21552` permission.asked bash `ls -la`: the `bash: ask` config applies to the plan agent too. `#1810 t=40411` tool:**question** pending → `#1813 t=44609` question.asked with **3 clarifying questions** (headers "Failure behavior", "Validation strictness", "Scope") → recorder POST `/question/:id/reject` (`#1814`) → `#1815` part running → `#1820 t=44614` **question.rejected** `{sessionID, requestID}` → `#1821` tool part **`error`, `error:"The user dismissed this question"`** → `#1823` step-finish(**tool-calls**) → `#1827 t=44700` assistant completed, `finish:"tool-calls"`, **no `error`** → `#1829 t=44700` **idle**. There was no `busy` just before it and no further LLM step. The rejection halted the loop.

**`plan_exit` never ran**, no plan file was written, and no plan-review question exists in any fixture. The recorder rejects *every* question in plan mode (`opencode.ts`, the `question.asked` branch), so it killed the turn at the clarifying-question stage.

### subagent (foreground task)
`#456 t=11833` P tool:task pending (`state.input:{}`, no metadata; 2.7 s of input generation) → `#458 t=14528` **C session.created** `{parentID:P, agent:"general", title:"Count lines in src/ files (@general subagent)", permission:[{permission:"task", pattern:"*", action:"deny"}]}` → `#460 t=14528` P task part **running**, `title:"Count lines in src/ files"`, `metadata:{parentSessionId:P, sessionId:C, model:{modelID, providerID}}` → `#470` the same running snapshot again (duplicate) → `#472 t=14528` C busy → C runs glob, bash (`#553 t=18103` permission.asked **sessionID=C**), bash (`#641 t=23236` permission.asked **before** `#643` running) → `#807 t=26694` **C idle** → `#810 t=26694` P task part **completed**, `output:"<task id=\"ses_…C\" state=\"completed\">\n<task_result>…</task_result>\n</task>"`, `metadata.truncated:false` → `#815` P step-finish(tool-calls) → `#821` P busy → … `#909 t=28789` **P idle**.

No P `session.status` frame arrived between `#74 t=2726` and `#821 t=26783`. P stayed `busy` throughout the child's run. P was silent while the child ran, apart from the task-part snapshots.

### subagent-background (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1`)
`#216 t=6977` P tool:task pending → `#218 t=8720` **C session.created** (parentID=P) → `#220 t=8720` P task running, `metadata:{parentSessionId, sessionId:C, model, background:true}` → `#230` duplicate → `#232 t=8720` **P task part completed immediately**: `output:"<task id=\"ses_…C\" state=\"running\">\n<summary>Background task started</summary>…"`, `metadata.background:true, jobId:"ses_…C"` (jobId = child session ID), `time.end - time.start = 8 ms` → `#234 t=8721` C busy → P keeps going: `#237` step-finish → `#243` busy → text "started" → `#272 t=9703` **P idle** + `#274` session.idle, **while C is busy** → C events interleave (`#281–#466`) → `#469 t=15621` **C idle** → `#471` C session.idle → `#472 t=15621` **P user message** `{role:user, agent:build, model}` (no synthetic flag on the message) → `#474 t=15621` its part `{type:text, synthetic:true, text:"<task id=\"ses_…C\" state=\"completed\">\n<summary>Background task completed: Summarize README.md</summary>\n<task_result>…</task_result>\n</task>"}` → `#481 t=15626` **P busy** → `#482` assistant msg with `parentID` = injected user msg → `#622 t=18399` **P idle**.

P was idle with C busy for **5,923 ms** (`t=9703→15626`). The injected message arrived **5 ms before** P's busy.

### background-shell
OpenCode has no background shell. After 165 s of reasoning (`#77 t=4763 → #9331 t=169446`, 9,265 deltas), the model ran `nohup bash -c 'sleep 15 && echo finished' > …/sleep_output.txt 2>&1; echo "pid=$!"` (`#9337` permission, `#9345 t=170253` completed, `pid=94500`). In the next step it streamed "launched" (`#9373 t=173123`) **in the same turn** and then ran a foreground polling loop `for i in $(seq 1 60); do kill -0 94500 …` (`#9375` permission, `#9384 t=186234` completed with output `finished`). Final text `#9436`, idle `#9445 t=187558`. One continuous turn with no BackgroundTask. The detached `nohup` process was never visible to OpenCode.

### interrupt
`#155 t=5318` bash pending → `#157 t=5547` running → `#159 t=5565` permission.asked → `#162` replied → `#163 t=5571` running `metadata.output:""` → `#166 t=13549` recorder POST `/session/:id/abort` → **`#168 t=13554` session.error `{sessionID, error:{name:"MessageAbortedError", data:{message:"Aborted"}}}`** → **`#169 t=13554` idle** → `#171` session.idle → **`#172 t=13558` bash part `completed`** (not `error`), `output:"(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>"`, `metadata.exit:null` → `#174 t=13600` abort HTTP 200 `true` → **`#175 t=13600` assistant `message.updated` with `error:MessageAbortedError`**, `time.completed` set, no `finish`, tokens all 0 → **`#177 t=13600` second idle** → `#178` second session.idle. No step-finish, no session.updated or session.diff, and no trailing user update.

### retry-overloaded
`#17 t=1297` busy → `#18` assistant msg (never completed) → `#74 t=2100` busy → `#75 t=3378` **`{type:"retry", attempt:1, message:"The backend is temporarily overloaded. Please retry.", next:1790919680257}`** → busy `#76 t=5606` → retry 2 `#77 t=7913` → busy `#79 t=12411` → **61 s with only heartbeats** (`#80–#85`) → retry 3 `#86 t=73739` → busy `#88` → retry 4 `#89 t=84226` → busy `#92` → retry 5 `#93 t=104673` → recorder max-time `#95 t=120250`.

Status keys are exactly `type, attempt, message, next`. **No `action`** on any of the 5. `next − now` = 2,226 / 4,497 / 8,755 / 18,953 / 34,803 ms, roughly doubling. (Clock offset between the server and the recorder is −2 ms, from message `time.created` vs `startedAt+t`.) No `retry` part, no `session.error`, no message error.

## 2. Open questions from the research doc

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Child events interleaved on `/global/event` under the parent's `directory`? | **Answered: yes.** The child carries the same `directory`/`project`. The child's events interleave with the parent's when both are active. | `subagent-background#234–#278` (C busy and P steps interleaved), `#281–#491`; envelope census |
| 2 | `retry.action.reason` values; 429 vs 5xx vs network | **Partially.** Overload (5xx-class) retry has **no `action`** and only free text `message`. 429 and network were not observed. Classify from `message` text. | `retry-overloaded#75,#77,#86,#89,#93` |
| 3 | Does a v1-driven session emit `session.next.*`? `/api/session/:id/history` | **Partially.** With default flags: no `session.next.*` in any of 9 runs. History route not exercised. | type census |
| 4 | Is `session.status idle` always after the final `message.updated`? | **No.** True for normal and question-reject ends. On abort, `idle` arrives **before** both the tool part's final state and the errored assistant `message.updated`, followed by a second `idle`. Also, a user `message.updated` (summary) always trails idle by 25–50 ms. | normal: `tool-read#175→#178`, `plan-review#1827→#1829`; abort: `interrupt#169` idle < `#172` part < `#175` msg < `#177` idle |
| 5 | Background subagent end to end | **Answered.** Task part completes in about 8 ms with `background:true, jobId=<child id>` → P idle while C busy → C idle → synthetic user text `<task id=C state="completed">` injected into P → P busy → P idle. | `subagent-background#232, #272, #469, #472–#474, #481, #622` |
| 6 | `GET /permission` without `directory` | **Unknown.** Not exercised. The recorder always passes `?directory`. | — |
| 7 | Do `always` approvals persist? | **Unknown.** Only `once` was sent. | all `permission.replied` have `reply:"once"` |
| — | Order of task `metadata.sessionId` vs child `session.created` | **Answered.** Child `session.created` comes **first**, in the same ms, then the task part goes `pending → running` with metadata. The `pending` snapshot never has metadata. The `running` snapshot is emitted twice. | `subagent#456, #458, #460, #470`; `subagent-background#216, #218, #220, #230` |
| — | What `plan_exit` looks like, and what reject does | **Unknown for `plan_exit`** (never called). **Answered for question reject**: tool `error` "The user dismissed this question" → step-finish(tool-calls) → message completed with no error → idle. The turn ends without another LLM step. | `plan-review#1820–#1829` |
| — | Interrupt sequence and errors | **Answered.** See §1 interrupt. The error appears as `session.error` and on the assistant message as `MessageAbortedError`. The running bash part ends `completed` with `exit:null` and an "User aborted the command" marker. | `interrupt#168–#178` |
| — | Does the parent stay busy during a foreground task? | **Answered: yes.** | `subagent` no P status between `#74` and `#821` |
| — | Are child permissions tagged with the child's session? | **Answered: yes** (`sessionID`=C). `tool.callID` points into C's transcript. | `subagent#553, #641` |

## 3. Subagent tree linkage (exact fields)

```
child session  C  = session.created.properties.info.id            (== properties.sessionID)
parent session P  = session.created.properties.info.parentID
spawning part     = message.part.updated where part.sessionID == P
                    && part.type == "tool" && part.tool == "task"
                    && part.state.metadata.sessionId == C
                    (also metadata.parentSessionId == P)
  ├─ callID       = part.callID          (e.g. "chatcmpl-tool-b55e4a2600a65184")
  ├─ partID       = part.id, messageID = part.messageID
  ├─ background   = part.state.metadata.background === true
  ├─ jobId        = part.state.metadata.jobId   (background only; == C)
  ├─ model        = part.state.metadata.model {providerID, modelID}
  └─ input        = part.state.input {description, prompt, subagent_type, background?, task_id?}
child agent name  = info.agent ("general"); title = "<description> (@<agent> subagent)"
result (fg)       = P task part state.output  `<task id="C" state="completed"><task_result>…`
result (bg)       = P new user message, text part synthetic:true
                    `<task id="C" state="completed|error"><summary>…</summary><task_result>…`
```

Binding rule: create the child Agent on `session.created` (`parentId` from `info.parentID`, `spawnedBy` unset). Bind `spawnedBy`/`background` on the first task part whose `metadata.sessionId` matches, which arrives in the same tick (`subagent#460`). If a P task part with that `metadata.sessionId` is already known (resume via `task_id`), reuse the existing child agent. Fallback: `GET /session/:P/children`.

## 4. Status algorithm for the OpenCode adapter

### 4.1 Adapter state per session `S`

- `st`: last `session.status` (`idle | busy | retry{attempt,message,next}`). Initially `idle`. Collapse duplicate frames.
- `parts`: partID → `{type, tool?, callID?, status?, metadata?, timeEnd?}`. Deltas are routed through it.
- `msgs`: assistant messages `{id, parentID, completed, finish, error}` and user message IDs with their parts.
- `interactions`: open `permission.asked` / `question.asked` by request `id` → `{callID}`.
- `abortPending`: set on `session.error{MessageAbortedError}` for S, cleared on next `busy`.
- `children`: C → `{callID, background, jobId, delivered:false}`.
- `ownUserMsgIds`: IDs ace sent. ace should pass its own `messageID` in the prompt body so injected messages can be told apart from its own.

### 4.2 Facts → canonical events

| Native | Canonical |
| --- | --- |
| `session.created` without parentID (ace-created) | root `agent.created` (origin `root`, fidelity `full`, native.nativeId=S) |
| `session.created` with `parentID` | `agent.created` (origin `provider_subagent`, fidelity `full`, parentId). Later `agent.updated{spawnedBy, background}`. **Needs schema change, see §5.** |
| task part with `metadata.sessionId` | ToolCall kind `agent.spawn`, `detail.childAgentId`. If `metadata.background`: `background_task.started{kind:"subagent", childAgentId, toolCallId, stoppable:true}` and `toolCall.backgroundTaskId`. The ToolCall itself goes `succeeded` (`subagent-background#232`). |
| user message not in `ownUserMsgIds` whose text part has `synthetic:true` and matches `^<task id="(ses_[^"]+)" state="(completed\|error)">` | `background_task.updated{completed\|failed}` for that jobId, and the next run's trigger is `subagent_result`. Other foreign user messages give trigger `unknown`. The plan-mode reminder is a synthetic part on **ace's own** message (`plan-review#18`), which is why the trigger must be keyed on message ownership and not on `synthetic` alone. |
| `busy` after idle | `run.started` (run native = the latest user message ID; trigger as above, else `user`) |
| `idle` | `run.ended` (`interrupted` if `abortPending`, `failed` if a non-abort `session.error` or message error arrived in this run, else `completed`) |
| `permission.asked` | `interaction.opened{approval, blocking:true, toolCallId ← tool.callID}`. Options: `once`→allow_once, `always`→allow_session (in-memory per server instance), `reject`→deny (+ message). Tool status `awaiting_approval`. |
| `permission.replied` | `interaction.closed{resolved}` |
| `question.asked` | `interaction.opened{question}`. `Question.id = "<requestId>#<i>"`, `text=question`, option `id=label`, `multiSelect = multiple ?? false`, `allowOther = custom ?? true` (keys absent in 1.18.33: `question#112`). |
| `question.replied` / `question.rejected` | `interaction.closed{resolved}` with answers / with dismissal (**schema change, §5**). The tool part goes to `error` → ToolStatus `declined`. |
| tool part terminal while `abortPending` (or `metadata.exit===null` and the output contains `User aborted the command`) | ToolStatus `cancelled`, not `succeeded` (`interrupt#172`) |
| `retry` | agent `blocked{on: classify(message), until: next}` (see 4.3) |
| `step-finish` | `usage.updated` (`tokens.input/output/cache.read`, `cost`) |
| server exit / SSE loss | open interactions → `expired`. Mark agents `unresponsive` until a resync. |

### 4.3 Per-agent status (evaluate after each frame, in priority order)

1. Server-level: no SSE frame at all (heartbeats included) for >25 s, or SSE closed → `unresponsive{lastSignalAt}` for every non-settled agent. **Do not** use per-agent silence: `retry-overloaded` was legitimately silent for 61 s apart from heartbeats (`#79→#86`), and a 2.7 s task-input gap (`subagent#456→#458`) is normal.
2. Open interaction for S → `blocked{human, refs:[interactionIds]}`. This holds while `st` is `busy` (`approval-edit#146`).
3. `st = retry` → `blocked{on, until:next}`. `on` = `rate_limit` if `/429|rate.?limit|too many requests|quota/i`, `network` if `/ECONN|ENOTFOUND|network|socket|fetch failed|timed? ?out/i`, else proposed `upstream` (§5). The observed text "The backend is temporarily overloaded" falls in the last group.
4. `st = busy`:
   - any non-background task part in `pending|running` whose child is not settled → `blocked{subagents, refs:[childAgentIds]}`;
   - else `working{activity}`, where activity is: a newest `pending|running` tool part → `tool` (itemId; `pending` means input is still being generated, 0.8–4.2 s in `question#110→#112`, `plan-review#1810→#1813`); else an open reasoning part → `thinking`; else an open text part → `responding`; else a previous `retry` in this run with no parts yet → `retrying`; else `starting_turn` (the ~3 s `busy → step-start` gap).
5. `st = idle`:
   - **pending input**: ace sent a prompt not yet followed by `busy`, or the latest user message has no assistant message with `parentID` = it and `time.completed` set → `starting`. This covers the 5 ms window `subagent-background#472→#481` and the ~650 ms prompt→busy window.
   - any `background_task` of S with status `running` → `blocked{background_task, refs}` (`subagent-background` `t=9703–15621`);
   - last run ended `interrupted` → `interrupted`; `failed` → `failed{kind}` (classify `error.name`: `ProviderAuthError`→auth, `APIError`→provider, `ContextOverflowError`→provider, else unknown);
   - else `idle`.

Background task completion: mark `completed`/`failed` when the injected `<task id=C …>` message reaches P (`#472–#474`), **not** on C's idle (`#469`). With this ordering, P goes `blocked{background_task}` → `starting` → `working`, and never passes through `idle`. Fallback: if C is idle and no injection arrives within 3 s, mark the task `completed` and P `idle`. Not observed.

### 4.4 Thread "done"

`done` ⇔ every agent in the tree is `idle` or `interrupted`, and no interaction is `pending`, no background task is `running`, no input is queued in ace, and no agent is `starting`. Any `failed` agent with the rest settled → `failed`. `unresponsive` dominates. Edge cases from the fixtures that the derivation must survive:

- `idle` emitted twice on abort (`interrupt#169, #177`). The first one precedes the errored message, so set `abortPending` from `session.error` (`#168`) and don't wait for the message.
- `busy` emitted right before `idle` in the same ms (`tool-read#177–#178`). Don't start a run on `busy` if `idle` follows in the same tick; equivalently, start runs only on a user message plus `busy`.
- Trailing user `message.updated` after idle (`tool-read#184`) and child user updates after the parent resumed (`subagent#828`) are not activity.
- A question reject ends the turn with `finish:"tool-calls"` and no error (`plan-review#1827`). The run is `completed`, not `failed`. Use `time.completed`, not `finish`, for "answered".
- Parent idle while background child busy (`subagent-background t=9703–15626`). This is the main false-done trap.
- `permission.asked` comes before the tool part reaches `running` in some cases and after it in others (`subagent#641` vs `#553`, `approval-edit#146`), and `question.asked` always comes before `running` (`question#112/#114`). Key by `callID`; the `pending` part always exists first.
- A long `busy` with only reasoning deltas (165 s, `background-shell`) is healthy `working{thinking}`.

## 5. Contradictions with the research doc and protocol gaps

**Corrections to the research doc**

1. "Provider retries set `retry{attempt, message, action?, next}` … A `retry` part is also written." In 1.18.33 there was no `action` and no `retry` part on the stream (`retry-overloaded#75–#93`).
2. "Children get denies for todowrite/task": the child's `permission` was only `[{task, *, deny}]` (`subagent#458`, `subagent-background#218`).
3. "(b) arrives in the same tick": correct, but it arrives **after** `session.created`, and `running` is emitted twice.
4. The interrupted tool is `completed`, not `error`. The research doc only mentions `MessageAbortedError` on the assistant message.
5. `question.asked` options carry no `multiple`/`custom` keys.
6. `session.diff` was empty after an edit. Use `patch` parts, tool `metadata.diff` or user `summary.diffs` instead.
7. "Background shells: none built in" is confirmed. The model fakes them with `nohup` plus a polling loop inside one turn (`background-shell#9337–#9384`). A detached process the model doesn't poll is invisible to ace.

**`sync` envelope.** Every durable event (`session.created/updated/deleted`, `message.updated`, `message.part.updated`) is followed **immediately** by `{payload:{type:"sync", id, syncEvent:{id, type:"<type>.1", seq, aggregateID:<sessionID>, data}}}`. `data` is byte-identical to the plain `properties`, the id is the same, and `seq` starts at 0 per session and had no gaps across all 9 files. The `sync` stream does **not** cover `session.status`, `session.idle`, `session.error`, `session.diff`, `permission.*`, `question.*`, `message.part.delta`, `file.*` or `todo.*` (sync census). **Recommendation:** process the plain events. Use the `sync` twin only to record `(aggregateID, seq)` for gap detection on reconnect: a gap → refetch `/session/:id/message`. Drop `sync.data`. Consuming `sync` alone would lose status, HITL and streaming. Consuming both doubles every durable fact unless the adapter dedupes by `payload.id`.

**Proposed `packages/protocol` changes**

1. `agent.updated`: add `spawnedBy: ItemId.optional()` and `background: z.boolean().optional()`. The OpenCode child is announced before the spawning tool part is linked (`subagent#458` before `#460`).
2. `BlockedReason`: add `"upstream"` (provider overloaded or 5xx). Add `attempt: z.number().int().optional()` and `message: z.string().optional()` to `blocked`, so the UI can show "retry 3, overloaded, next in 9 s". Add `"upstream"` to `ThreadStatus.waiting.on` (`retry-overloaded#75`).
3. `InteractionResolution` question variant: add `dismissed: z.boolean().default(false)` (or a `decision: "answer" | "dismiss"`). OpenCode question reject is a user action with turn-ending effects, and neither `answers` nor `cancelled` (which means "provider withdrew it") describes it (`plan-review#1820`).
4. `Run`: add `native: NativeRef.optional()`. For OpenCode a run is keyed by the prompting user-message ID. All step messages share it as `parentID`.
5. Document in `ThreadStatus` that `interrupted` counts as settled for `done`. Consider `done{lastRun?: "completed" | "interrupted"}` so lists can show "stopped" vs "finished".

**Recorder fixes before re-recording**

- `plan-review`: answer non-`plan_exit` questions with the first option, and reject only when the question's `tool.callID` belongs to a `plan_exit` part. Otherwise the plan_exit flow will never be captured.
- Add scenarios for `permission reject`, `always`, abort during a foreground subagent (cascade), and abort while a background child runs.
- The background-shell prompt is not meaningful for OpenCode. It cost 165 s of reasoning.

## Addendum: round-2 recordings (2026-10-02)

The recorder now rejects only questions asked by `plan_exit` and answers every other question. `interrupt` was re-recorded with a foreground loop that prints a line every second.

- **plan-review:**
  - A clarifying `question` (three questions, answered with the first options) is answered at t=71873.
  - `plan_exit` goes `pending` at t=113465, and the recorder rejects its question.
  - The part ends `state.status: "error"` with `error: "The user dismissed this question"`, which maps to `InteractionResolution{kind: plan_review, decision: reject}`.
  - The plan was written to a file during the turn, and the question carries no plan text.
- **interrupt:** after `POST /abort` at t=16649:
  - `session.error` and `session.status idle` arrive at t=16661.
  - The bash part flips to `completed` at t=16669, after idle.
  - A second `idle` arrives at t=16725.
  - The status algorithm must accept tool completions after idle and must not treat the second idle as a new turn end.
