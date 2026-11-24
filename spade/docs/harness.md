# The harness (agent loop)

Date: 2026-11-11. How a turn runs, as built in `spade-core` (decisions, no I/O) and
`spade-server` (the engine and API). Extends [chat-core.md](chat-core.md).

## Events added for turns

| Type                                         | Fields                                                                                  | Meaning                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_message`                               | `text`, `context?`                                                                      | `context` (time, memories) is fixed when stored, so the prompt rebuilds to the same bytes                                                                                                                                                                                                                                                                          |
| `skills_indexed`                             | `text`                                                                                  | The skill index, stored before the first model call and again after each compaction; the latest is in effect                                                                                                                                                                                                                                                       |
| `plugins_started`                            | `rules`, `added?`                                                                       | The bot's plugin rules and `SessionStart` text, stored like the skill index and after `plugins_changed`; the latest is in effect ([plugins.md](plugins.md))                                                                                                                                                                                                        |
| `plugins_changed`                            |                                                                                         | The person changed which plugins the bot may use; its rules are stored again before the next model call                                                                                                                                                                                                                                                            |
| `hook_ran`                                   | `hook`, `target`, `outcomes[]`                                                          | What the bot's plugin hooks answered at one event, stored once so a restart never runs them again ([plugins.md](plugins.md))                                                                                                                                                                                                                                       |
| `memory_indexed`                             | `text`                                                                                  | The notes index for the cached top, fixed before the first model call and after each compaction (memory.md)                                                                                                                                                                                                                                                        |
| `question_asked`                             | `reply`, `call_id`, `question`, `questions`                                             | `ask_user` asked a card; the turn waits unless a `question_deferred` follows ([questions.md](questions.md))                                                                                                                                                                                                                                                        |
| `question_deferred`                          | `call_id`, `by_bot?`                                                                    | Left for later; the call is answered at once                                                                                                                                                                                                                                                                                                                       |
| `question_answered`                          | `call_id`, `answers`, `late?`, `typed?`                                                 | The person's checked answers. A `late` one is delivered like a job result, read as a `<question_answer>`                                                                                                                                                                                                                                                           |
| `question_dismissed`                         | `call_id`, `late?`                                                                      | Never mind; a `late` one is delivered like a late answer                                                                                                                                                                                                                                                                                                           |
| `step_finished`                              | `reply`, `text`, `calls[]`, `thoughts[]`, `usage`, `cost_micros`, `seen`                | One model call ended. `thoughts` are kept whole (signed and redacted thinking, `reasoning_content`) and sent back as they came; `seen` is how many events its prompt was built from                                                                                                                                                                                |
| `approval_requested`                         | `reply`, `call_id`, `name`, `arguments`                                                 | The gate is waiting on the person                                                                                                                                                                                                                                                                                                                                  |
| `approval_answered`                          | `reply`, `call_id`, `allowed`, `always`                                                 | `always` allows that tool for the rest of the conversation                                                                                                                                                                                                                                                                                                         |
| `tool_started` / `tool_finished`             | `reply`, `call_id`, `name`, (`content`, `is_error`)                                     | A tool ran                                                                                                                                                                                                                                                                                                                                                         |
| `context_compacted`                          | `summary`, `keep_from`, `tokens_before`, `carried?`, `asks?`                            | The model now sees `summary`, then events from index `keep_from`. `carried` is its "already carried out" list and the person's messages kept word for word (`said`, `said_earlier`), carried forward by the next compaction; `asks` is the person's asks as they stood, where the next fold starts (ADR 0215)                                                      |
| `results_aged`                               | `before`                                                                                | With aging turned on, tool results before index `before` that may age show as stubs from now on ([ADR 0216](../../docs/adr/0216-spade-compacts-late-and-keeps-the-persons-words.md)); stored in batches                                                                                                                                                            |
| `asks_updated`                               | `call_id`, `changes[]`                                                                  | What one `asks` call changed in the person's asks, as Spade accepted it; the ledger reads only this (ADR 0215)                                                                                                                                                                                                                                                     |
| `asks_checked`                               | `reply`, `asks[]`, `note`                                                               | The stop check ran in `reply`, naming those open asks; the model reads `note` as Spade's, and the reply takes one more step                                                                                                                                                                                                                                        |
| `asks_reminded`                              | `reply`, `steers[]`, `note`                                                             | The first step that read these steers made calls but didn't answer them; the model reads `note` as Spade's (ADR 0215 §4)                                                                                                                                                                                                                                           |
| `asks_noted`                                 | the ledger                                                                              | A copy of the person's asks, stored every 500 events it reads, so a fold after a restart reads only what came since (ADR 0215)                                                                                                                                                                                                                                     |
| `command_ran`                                | `reply`, `call_id`, `contained`, `exit_code?`, `timed_out?`, `reached[]`, `refused[]`   | Where a `shell` command (or a `python` run) ran and how: `contained` when Spade's sandbox held it, the hosts it reached and the ones the network policy refused (`{host, port, reason}`). Stored right after its `tool_finished` (or, for a command that became a job, before its `job_finished`); the model never reads it, the app shows it in the reply's steps |
| `job_started`                                | `reply`, `job`, `name`                                                                  | A background tool's call was handed to a job (its `tool_finished` says so at once)                                                                                                                                                                                                                                                                                 |
| `job_finished`                               | `job`, `name`, `content`, `is_error`, `untrusted?`, `cost_micros?`                      | The job ended; the model reads it as a `<job_result>`. Stored once per job. `untrusted` taints the turn that reads it ([helpers.md](helpers.md))                                                                                                                                                                                                                   |
| `stop_requested`                             | `reply?`, `jobs[]`                                                                      | The person pressed Stop on that reply and those jobs. They stop; a result of a named job, or of a job the reply started, opens no reply. Later work is untouched                                                                                                                                                                                                   |
| `turn_paused`                                | `reply`                                                                                 | Spade paused the open reply for an update or a stop, with nothing of it running. It stays open (the conversation still reads as working) and resumes from its events on start                                                                                                                                                                                      |
| `wake_set` / `wake_fired` / `wake_cancelled` | `wake`, `reply`, `purpose`, `due_ms?`, `condition?`, `reason` / `cause`, `note?` / `by` | Every timed or event-driven resume: a sleep, a wait, a turn waiting out an outage, a parked job, a task parked for its check. Fires once ([autonomy.md](autonomy.md))                                                                                                                                                                                              |
| `task_parked` (retired)                      | `reason`, `until_ms?`, `why`                                                            | Stored by earlier builds for a task waiting on a cap. Still read and ignored: when Spade opens the task is planned again                                                                                                                                                                                                                                           |
| `turn_parked` (retired)                      | `reply`, `until_ms`, `round`, `why`                                                     | Stored by earlier builds for a turn waiting for its endpoint. Still read: the reply stays open across a restart, waits until `until_ms`, and `round` counts toward the backoff                                                                                                                                                                                     |

`reply_finished` closes a turn whose last step made no tool calls; its `cost_micros` is the
turn's total.

A bot's tree of workers adds `worker_of`, `worker_started`, `worker_reported` and
`worker_detached` (ADR 0161, [workers.md](workers.md)). `worker_budget` and `cap_reached`, stored by
builds with budgets and caps, are read as raw data and fold to nothing ([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md)).

## How a turn runs

`spade_core::turn::next_step(events)` decides, from stored events only:

- **Call the model** when the last step's calls all have results (or there is no step yet). The
  prompt is `context::prompt`: Spade's rules and the skill index (fixed between compactions), the offered tools (core
  tools in name order, plus `tool_search` and `call_tool` when any tool is deferred), then the
  conversation. It only ever grows at the end.
- **Handle calls** otherwise: each open call is new (to the gate), awaiting, allowed, declined or
  running. The gate runs reads; asks for writes unless allowed always; always asks for
  destructive calls and for any write in a turn that read untrusted output (`web_search`,
  `web_fetch`, email). What the gate would ask goes to a reviewer model, which approves or
  refuses it; the person is asked only when the bot retries a refused step or the review can't
  run ([autonomy.md](autonomy.md)). Allowed calls run in parallel (at most 16 at once, or what
  `SPADE_PARALLEL_TOOLS` sets; the rest wait their turn); a result over 20,000 characters keeps its first and last
  10,000, with a note of how much was left out between them (the end is where errors and summaries
  usually are). No call is timed out by the harness: one still running after the
  foreground window (`Limits.foreground`, 30 s) carries on as a background job with the same run,
  its call answered with the job id, and the turn goes on ([ADR 0158](../../docs/adr/0158-spade-no-fixed-step-or-time-limits.md)). A declined call returns "The person declined this action."
- **While the step streams**, Anthropic closes each tool block, and Chat Completions closes
  its calls with the tool-call finish reason. OpenAI Responses holds its item boundaries until a
  real terminal event. A clean EOF without that event still uses the SDK's final reply and skips
  early gating. Spade assigns conversation-unique ids before early work. The final provider
  call list supplies the order and arguments for `step_finished`. The ordinary gate runs on
  the stored step with current settings and can reuse early work only for an exact call match.
- A workspace text or image read can start early in an existing workspace. Before using its
  output, Spade checks the file's identity, size and modification time, and checks its trust
  record again. Any change triggers a fresh read. Listings, searches and document reads wait
  for storage. File opens use `O_NOATIME` on Linux where allowed. On macOS and where the flag
  is unavailable, an ordinary read may update access time. Early and ordinary foreground work
  share the same tool concurrency limit. Blocking file work keeps its slot until it exits,
  even if Stop or a timeout cancels the caller.
- An eligible early review sends the call and context to the person's configured review model
  before the step is stored. Spade records spend against the conversation even if the step is
  never stored. Each request settles once. Reusing its verdict adds no ledger entry, and a
  cancelled request that may have been billed gets an estimate. The verdict stays in memory
  until the stored gate asks the same question with the same reviewer, launch and binding.
- Approvals, questions and effectful calls follow the stored step. Bots with plugin pre-tool
  hooks or local plugin servers, packaged or shared bots, and app calls that need pins seeded
  also wait. Stop, a cut stream, an immediate pause, or a crash discards early read results and
  review verdicts for an unstored step. It leaves no call or approval event to recover. After
  streaming starts, a failure never triggers an automatic resend. A planned pause can still
  resume a cut step under the pause rules below. Recovery uses the log. An unstarted stored call
  goes through the gate when the turn resumes, a stored review can be reused, and a stored start
  without a result follows the existing unknown-outcome rules.
- **Steering:** a message sent mid-turn is stored at once and the next model call sees it, placed
  after any running tools' results, and after the step it arrived during. A turn finishes only if
  nothing arrived after its last step's prompt was built (`seen`), checked under the same lock that
  decides steer-or-start, so a message is never lost.
- **The person's asks** ([ADR 0215](../../docs/adr/0215-spade-keeps-the-persons-asks.md),
  `spade_core::asks`): every message from the person (for a worker, its maker's) opens an ask,
  marked when it came while a reply ran. The bot sorts and closes asks with the `asks` tool
  (open, split, done, dropped, changed, waiting, chat, and standing instructions it records and
  lifts); while untrusted content is in the prompt's view (the rule notes follow) it may only change states, and only a later message from the person lifts a standing instruction. Each model call ends
  with a short `<asks>` block rebuilt from the ledger: standing instructions, open asks newest
  first (at most 12, the rest counted), then new messages not yet sorted. It is never stored and
  comes after everything stored, so every earlier byte is what the previous call sent and the
  provider's cached prefix holds. A `cli:` brain gets it at the end of each turn's message; a helper gets none. The
  ledger is folded from its latest stored copy (`asks_noted` or a compaction's, looked for in
  the last 2,000 events) and kept in memory per conversation, so a step reads only the events
  since the last one.
- **Steers** (ADR 0215 §4): a message the person types while a reply runs (not a typed answer
  to a waiting card) reads to the model as `<steer>…</steer>`, in the place steering puts it,
  and to a `cli:` brain the same way. The bot is told to answer it in words and record it with
  `asks` in its next step. When that step made calls but said nothing to the person or left the
  steer unsorted, Spade stores `asks_reminded` before the next call, whose note the model reads
  as Spade's: once per steer, never a loop. A reading step with no calls ends the reply, where
  the stop check names an unsorted steer.
- **The stop check:** when a step makes no calls and the ledger has an open ask (unsorted ones
  count) that no earlier check named, Spade stores `asks_checked` and runs one more step with a
  note naming them: finish them, or mark each with a reason. A step that only answers it with
  `asks` calls ends the reply once they are answered. At most once per reply, and never while a
  question the bot asked waits on the person, for a paused bot, a stopped reply, while Spade
  pauses, or for a helper. A reply whose last step has no words keeps its latest words.
- **Call ids:** a provider may reuse ids across steps (`call_0` in every reply); a reused id is
  replaced before any early work or, for later calls, before the step is stored. Results and
  approvals always use the assigned id.
- **Background tools:** a tool marked `background` answers its call at once and runs as a job
  (with no time limit; Stop ends it). Its result is delivered like a message: it steers the open reply or starts a
  new one. Stop cancels jobs and records them stopped without starting a turn. After a restart a
  job the old process was running is delivered as "unknown outcome", except: a helper's job runs
  again and waits for its helper ([helpers.md](helpers.md)); a `delegate` or `wait` job runs
  again and reattaches to ace's children (below); a job parked for a retry stays parked and runs
  at its wake ([autonomy.md](autonomy.md)). Each job's end is stored once, whichever way it
  ran. The conversation list shows `jobs` running, so a conversation never reads as idle while
  one is out.
- **Sending a step again:** a model step that fails before anything streamed, because the
  request could not be sent or the endpoint answered `408`, `429` or `5xx`, is sent again: three
  tries in all, waiting 2 s and then 6 s, or the endpoint's `retry-after` when it gives one, and
  never more than 20 s of waiting in all (an endpoint asking for longer waits only what is left
  of that). The
  status line reads "Retrying" meanwhile; Stop and a pause end the wait. A refused request was
  never billed, so it costs nothing; only the call that answered is paid for. Once anything has
  streamed, or the endpoint answered at all (a `200` whose body was then cut or unreadable), the
  step is never sent again: it may have been billed, so it is paid for as an estimate and fails
  or is interrupted as below. Other
  refusals (`400`, `401`, `403`, a missing model) fail at once, and so does a `429` whose words
  say the account's quota or credit is used up: the person has to act, and the reply's failure
  says so.
- **Waiting out an outage** (ADR 0158, ADR 0160): when those three tries are used up on a
  failure that may pass (unreachable, `408`, `429`, `5xx`), the turn stores an outage wake,
  `wake_set {reply, purpose: {kind: outage, attempt, error}, due_ms}`, and waits for it: 1, 2, 4 … minutes, at most an hour, or
  the endpoint's longer `retry-after` (still at most an hour); the backoff starts again once a
  step of the turn finishes. When it fires (`wake_fired`, with no note) the step is sent again as
  it was, and the three quick tries start again. As many rounds as it takes. The reply stays open
  and the bot reads as `sleeping` with "The model is not answering; trying again at 14:05 (…)". Stop ends the wait and the
  reply; the person cancelling the wake ends the reply stopped; the person waking it, or writing
  (their message goes with the step), sends the step now. A pause ends the wait like any other,
  and after a pause or a restart the turn resumes and waits on the same wake. A helper's turn
  waits the same way. A refused key and a used-up quota fail at once.
- **Stop** cancels the model stream and running tools; calls left without a result are answered
  "not run" in later prompts.
- **No step or time limit:** a turn takes as many steps and as long as its work needs (ADR 0158).
  The person's control is Stop. Spend is recorded and shown, never a limit: no cap or budget
  refuses, ends or parks anything ([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md), [oversight.md](oversight.md)). With the model review on, a write the gate would run
  is judged by a second model first, which can only make it ask.
- **Restart:** a turn cut off mid-stream or mid-tool by a crash closes as `reply_interrupted`; a
  turn only waiting for an approval resumes, and so does a paused one (below).
- **Pausing** (docs/ace-integration.md, "Updates" and "Stop"): while admission is closed, messages
  and job results are stored but start no turn; they are answered when admission reopens or Spade
  starts. Each turn worker pauses at the next point where nothing of it runs: a streaming model
  step may finish first (30 s for an update, 5 s for SIGTERM, then it is cut and asked for again
  on resume), tools still running are cut and answered "unknown outcome", and a turn waiting on an
  approval pauses at once. The pause is stored as `turn_paused`. Stop on a paused reply closes it as
  stopped. The rules are in `spade_core::maintenance`.

## Task lanes

Main's own reply that runs long moves to a task lane of the bot's ([workers.md](workers.md),
"Lanes"; ADR 0217 §2a). At a step boundary (`Next::CallModel`, after the stop check and the asks
reminder) a reply that has taken 8 steps or run 2 minutes in this worker, with nothing waiting on
the person and no job or wait of its own open, is moved in one write under the record lock: the
lane's row and first events, and in main `lane_started`, `reply_moved` and the reply's close
(`reply_finished` with no text). The turn ends; the lane's turn worker carries the same reply on
from its next step. `Limits::move_long_work` turns this on (Spade does; tests choose). A lane's
own work never moves, and `task::next` never carries a moved task on in main.

Each step of main's ends with a `<tasks>` block after the `<asks>` block while lanes haven't
ended: one line each with its id, state, title and the asks it owns, read from the events.

## Internal questions

A helper's `ask_user` stores its wait and a `child_asked` event in the parent atomically.
Pending child questions appear after the parent's usual prompt tail. `child_answer` validates
the reply and closes both sides in one write. A pending question is offered again on restart.

## Tools

Every tool definition is paid for on every model call of every bot, so Spade offers up front only
the tools a bot needs constantly, in name order, and defers the rest. Core: `web_search` (ace
cloud search, then the model endpoint's own), `web_fetch` (saves a page's or PDF's full readable text as an
immutable snapshot under `web/` in the bot's workspace and returns a bounded handle: title, URL, length,
saved path, a heading outline with offsets and the first 4,000 characters; later calls with `offset` or
`query` read the saved snapshot once its digest verifies, and any cache miss refetches; refuses local
and private addresses; see media.md), `todo`, `asks` (the person's asks, answered by Spade from
the events, ADR 0215), `task_status`, `task_goal`, `task_plan`, `decision_log`, `task_update`
(the bot's task state; while `working`, Spade starts its next step after a reply,
[autonomy.md](autonomy.md)), `sleep_until` and `wait_for` (the bot ends its turn and is woken at a
time or by an event, ADR 0160, autonomy.md), `research` (a background job that runs one
read-only helper for each part of a question and answers with a compact report citing the page
behind every finding, each one a page that part's helper fetched, [oversight.md](oversight.md)), `helper` (a background job that hands
part of the work to a short-lived helper with a fresh context, in a hidden conversation of its
own, [helpers.md](helpers.md)), the workspace tools, `shell` and `python`
([workspace.md](workspace.md); the system prompt's "How you work" tells the bot to write and run a
short Python script for counting, data, files, conversions and charts rather than work them out,
ADR 0220), `skill_search` and `skill_load` over Spade's own skill store, which mirrors ace's
library while ace is there and works without it (workspace.md, "Spade's skill store"), `ask_user`,
`memory_save`, `memory_search`, `history_search`, `history_read`, `knowledge_search`,
`document_read`, `share_file`, the lane tools (`task_start`, `task_message`, `task_stop`, `tasks`),
and `tool_search` with `call_tool`, which are offered whenever anything is deferred.

Deferred, found with `tool_search` and run through `call_tool`: `card_show`, `panel_update`,
`notify`, `package_suggest`, `profile_update`, `club_add`, `skill_propose`, `skill_feedback`, the
routine tools, `knowledge_write`, `episode_search`, `memory_update`, `memory_forget`, the
typed-call tools (`contracts_find`, `contract_call`, `contract_return`), `bots_list`,
`group_ask`, `wake_cancel`, the service tools, the worker tools (`worker_message`,
`worker_status`, `worker_result`, `worker_stop`), the outward tools (`git_push`, `pr_comment`,
`issue_comment`, `send_message`), `image_generate` and a package's code tools. Each is rare in a conversation; one a bot does need costs
one `tool_search` round trip, once (see the pins below). Deferring changes only what is offered
up front: a deferred tool can still be called by name, and every name stays in the runtime API
(runtime.md). Output from `web_search`, `web_fetch` and most of ace's tools is untrusted, so a
write later in that turn asks.

**The stored list and learned pins.** A conversation keeps the tool list it was offered: it is
worked out at its first model call and again only when a compaction republishes it, so the
prompt's top stays byte-stable for the provider's cache (design.md, Caching). What is stored is the
ordered definitions themselves (`spade_core::tools::snapshot`, one `tools.offer.<conversation>`
setting per conversation), so a tool source coming, going or changing its schema never changes the
bytes mid-conversation or after a restart. A lane or helper captures its bot's list as it stood
when it started and keeps it: a parent compaction never changes a running one, and a helper's own
compaction leaves its bot's list alone. A bot's list carries its learned pins: a deferred tool it
ran twice is offered up front from its next list, at most 8, the most run first, ties by name.
`spade_core::tools::pinning` keeps the tally per bot (`tools.uses.<agent>`, the 32 most run), and
the engine records a use when a deferred tool actually runs. A new list is published in the same
write as the compaction event it belongs to, and both settings are deleted with the conversation
and the bot.

`cargo test -p spade-server tool_tokens -- --nocapture` prints every offered tool's definition in
characters and tokens (a token per four characters), largest first, with the total; the test fails
past its budget, because the list is paid for on every call.

ace's tools (threads, agents, browser, screen, automations) come from the daemon's MCP endpoint
and can change while Spade runs. All of them are deferred: the model finds them with
`tool_search` and runs them through `call_tool`, so the offered list never changes and the cached
prompt top stays valid. Their risk comes from their annotations (unlabelled means write); ace's
`wait` and `delegate` run as background jobs. Such a job stays open until ace says the children
settled: ace's own wait ends after at most ten minutes with `timeout` (or `interrupted` while the
daemon restarts) while the children keep working, so the job calls `wait` again on the same threads,
as many times as it takes, and the bot reads as working meanwhile (AGENTS.md priority 1). Its one
result comes when they are done, one needs the person, or one is held at a usage limit. While ace
can't be reached the job keeps trying. After a restart a lost `delegate` or `wait` job is not
"unknown outcome": once ace's tools are back (within ten minutes) it runs again, and `delegate`
returns the same children for the same call, so it reattaches to them. When every search backend fails and ace is there, `web_search`
tells the model to have an ace agent search on the cheapest model the person has.

Connectors (the person's apps through their own remote MCP servers, [connectors.md](connectors.md))
are offered the same way: deferred, named `<connector>__<tool>`, risk from their annotations,
output untrusted, and only to bots the person allowed them.

The person's plugins ([plugins.md](plugins.md)) add rules to the standing instructions, hooks
at six points of a turn, and their local MCP servers' tools, offered like connectors': deferred,
named `<plugin>__<tool>`, output untrusted, only to bots the person allowed the plugin.

Each conversation gets a skill index in its instructions before its first model call: the 40
skills its bot loaded most, then by name, manual ones left out. It is stored again after each
compaction, the one point where the prompt's top changes anyway, so a skill installed weeks into a
bot's one conversation reaches its instructions; in between the bytes are fixed, and skills added
meanwhile are found with `skill_search`, which ranks by text and then by the bot's use
(workspace.md, "Ranking"). `skill_load` puts a skill's other files in
the bot's workspace at `skills/<name>/`.

## Old results age out

Off by default: models see every tool result whole. A person who wants a long task's prompt smaller
and cheaper turns on `age_results` for a bot or for every bot (model roles settings; ADR 0216), and
old tool results then show as stubs. Before each model call, after the compaction check, the engine
stores `results_aged { before }` when a batch is
due: the boundary is the start of the 4th latest step, moved back until at least 8 results follow
it, and a batch is due once the results between the previous boundary and it that may age add up to
64,000 characters. A result before the boundary shows as one line: the tool, its arguments
(shortened), its size, and `history_read {"from": <position>, "count": 1}`, `history_search` or
calling the tool again to get it back. A conversation not offered `history_read` ages nothing.
Never aged: errors, results of 2,000 characters or less,
results with images, `ask_user`, `skill_load` and `tool_search` results; the person's and the
bot's own words are not results and are always whole. Between two batches the prompt only grows at
its end, so the provider's cache holds; a batch rewrites the cache from its first newly aged result,
once (the ADR measures it). Deciding reads only the events since the latest boundary or compaction
cut.

## Compaction

Before each model call, if the next request's prompt reaches 90% of the smallest context window
among the models that may serve the step (the turn's model and its fallbacks; 200,000 tokens for a
model that doesn't say, capped by `SPADE_CONTEXT_TOKENS` when the person sets it as a cost choice),
or the lower cap the person set as `context_tokens` for the bot or for every bot on the model roles
settings (none by default, at least 16,000; ADR 0158, ADR 0216), the engine compacts. The prompt's size is estimated (`compaction::prompt_estimate`): what the latest
step since the last compaction reported, plus a token per 4 characters of everything stored after
it; with no report since the last compaction, the shown span's text alone, so a size from before a
compaction never counts. `tokens_before` stores that estimate. The cut is sized against the shown
span only (the latest summary and the events from its cut), never the history before it. A step's
own fresh results are never cut or aged, so when they overflow the window by themselves the request
still goes out over it, as before ADR 0216; bounding them is
[#2669](https://github.com/arpan404/ace/issues/2669). It cuts
at a person's message sent while no tool call was waiting for its result, so recent turns of about
35% of the window are kept (the same share of a lower cap as 35% is of 90%). It asks the conversation's own model for
a JSON summary (goal, decisions with who made them, open commitments, facts, open questions,
references, notes) by appending the request to
the current prompt with the same tools (no typed-output option, which would change the request and
miss the cache), counts that call's cost like any other, appends the writes already carried out
(from the events, never the summary), and stores `context_compacted`. The list stays bounded over
weeks: it holds the writes made since the previous compaction, then the previous summary's own list
carried forward (stored as `carried` on `context_compacted`, so the conversation is never walked from
the start again). Each write is one line: its tool, call id and arguments, with text over 120
characters cut to 80 plus its length, lists cut to their first 8 items and the whole kept under 400
characters. Writes since the previous summary and jobs still running are always listed; past
16,000 characters the oldest carried lines fold into a count that points at `history_search`. A job
listed as still running is looked at again at the next compaction (done, unknown, or dropped if it
failed). The person's own messages from the summarised span are kept word for word in the stored
summary, under the model's summary, and carried forward the same way (`said` on `carried`). Only
messages the person wrote count: here or in an ace thread (labelled so), never another bot's, a
routine's or one that came through a group, and none in a helper's conversation, whose brief is
the bot's. Each is quoted as its own block, every line starting `> `, under `[#position] The person
wrote:`, so nothing inside one passes for another or for Spade's words. A message over 3,000
characters keeps its start and its position; past 24,000 characters the newest message stays, then
standing instructions (a message under 600 characters with "always", "never", "from now on", …),
then the rest, newest first, and the oldest fold into a count that points at `history_search`. The
list is worked out before the summary is asked for, and the request names the messages kept only in
part and how many are not kept, so the summary holds their requirements. A compaction that cannot
be stored is not reported as done, so the turn goes on rather than paying for the summary again. A summary stored
before `carried` existed makes the next compaction walk from the start, once. Compaction is the one place earlier prompt bytes change: the system prompt and
tools stay cached, the conversation before the cut becomes the summary. If the summary fails, older turns are left out with a note saying
so. `POST /v1/conversations/{id}/compact` with an optional `{"focus": "…"}` compacts between
turns (409 mid-reply).

## API added

| Method and path                                   | Body                                              | Answer                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /v1/conversations/{id}/approvals/{call_id}` | `{allowed, always?}`                              | `202`; `409` if that call is not waiting                                                                    |
| `POST /v1/conversations/{id}/questions/{call_id}` | `{answers}`, `{defer: true}` or `{dismiss: true}` | `202`; `400` for answers that break the card's rules; `409` if it isn't open ([questions.md](questions.md)) |
| `POST /v1/conversations/{id}/compact`             | `{focus?}`                                        | `204`; `409` mid-reply or nothing to compact                                                                |
| `GET /v1/models`                                  |                                                   | The person's endpoints and models, presets, the fast model ([agents.md](agents.md))                         |
| `PUT /v1/keys/{endpoint}`                         | `{key}`                                           | `204`; stored in the OS keychain, never returned                                                            |
| `DELETE /v1/keys/{endpoint}`                      |                                                   | `204`; `404` if none                                                                                        |
| `POST /v1/maintenance`                            | `{mode, deadline_ms?}`                            | `202` with the state below; closes admission and starts pausing. `400` for an unknown mode                  |
| `GET /v1/maintenance`                             |                                                   | `{admission: "open"\|"closed", running_turns, running_jobs}`                                                |
| `DELETE /v1/maintenance`                          |                                                   | `200` with the state; reopens admission, paused turns carry on                                              |
| `PUT /v1/ace`                                     | `{grant}`                                         | `204`; kept in the keychain (account `ace:grant`), used at once                                             |
| `DELETE /v1/ace`                                  |                                                   | `204`; forgets the grant and disconnects                                                                    |
| `GET /v1/usage/search`                            |                                                   | `{signed_in, used, allowance, resets_at}`: this month's ace searches (design.md, Web search)                |
| `GET /v1/ace`                                     |                                                   | `{grant: bool, connected: bool}`, never the grant                                                           |

Maintenance details the contract leaves open: `POST` answers at once and the updater polls `GET`
until `running_turns` is 0 (and, for `idle`, `running_jobs` too). For `idle`, `deadline_ms` bounds
the wait for idleness: when it passes first, admission reopens and nothing is paused. For `now`,
it shortens the 30 s a running step gets. If no restart comes within five minutes of every turn
pausing (the updater died), admission reopens by itself. A `POST` while closed replaces the
earlier one. Without a keychain (Linux with no Secret Service) the ace grant is kept in memory
for that run only.

`spade --check-migrations <path>` migrates and integrity-checks the SQLite file at `path`
(a copy) and exits 0 if this build can use it, else 1 with one line saying why. It never opens
the data folder.

`POST /v1/conversations/{id}/messages` while a reply is open steers it (`202`).
