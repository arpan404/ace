# The harness (agent loop)

Date: 2026-11-11. How a turn runs, as built in `spade-core` (decisions, no I/O) and
`spade-server` (the engine and API). Extends [chat-core.md](chat-core.md).

## Events added for turns

| Type                                         | Fields                                                                                  | Meaning                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message`                               | `text`, `context?`                                                                      | `context` (time, memories) is fixed when stored, so the prompt rebuilds to the same bytes                                                                                           |
| `skills_indexed`                             | `text`                                                                                  | The skill index, stored before the first model call and again after each compaction; the latest is in effect                                                                        |
| `plugins_started`                            | `rules`, `added?`                                                                       | The bot's plugin rules and `SessionStart` text, stored like the skill index and after `plugins_changed`; the latest is in effect ([plugins.md](plugins.md))                         |
| `plugins_changed`                            |                                                                                         | The person changed which plugins the bot may use; its rules are stored again before the next model call                                                                             |
| `hook_ran`                                   | `hook`, `target`, `outcomes[]`                                                          | What the bot's plugin hooks answered at one event, stored once so a restart never runs them again ([plugins.md](plugins.md))                                                        |
| `memory_indexed`                             | `text`                                                                                  | The notes index for the cached top, fixed before the first model call and after each compaction (memory.md)                                                                         |
| `question_asked`                             | `reply`, `call_id`, `question`, `questions`                                             | `ask_user` asked a card; the turn waits unless a `question_deferred` follows ([questions.md](questions.md))                                                                         |
| `question_deferred`                          | `call_id`, `by_bot?`                                                                    | Left for later; the call is answered at once                                                                                                                                        |
| `question_answered`                          | `call_id`, `answers`, `late?`, `typed?`                                                 | The person's checked answers. A `late` one is delivered like a job result, read as a `<question_answer>`                                                                            |
| `question_dismissed`                         | `call_id`, `late?`                                                                      | Never mind; a `late` one is delivered like a late answer                                                                                                                            |
| `step_finished`                              | `reply`, `text`, `calls[]`, `thoughts[]`, `usage`, `cost_micros`, `seen`                | One model call ended. `thoughts` are kept whole (signed and redacted thinking, `reasoning_content`) and sent back as they came; `seen` is how many events its prompt was built from |
| `approval_requested`                         | `reply`, `call_id`, `name`, `arguments`                                                 | The gate is waiting on the person                                                                                                                                                   |
| `approval_answered`                          | `reply`, `call_id`, `allowed`, `always`                                                 | `always` allows that tool for the rest of the conversation                                                                                                                          |
| `tool_started` / `tool_finished`             | `reply`, `call_id`, `name`, (`content`, `is_error`)                                     | A tool ran                                                                                                                                                                          |
| `context_compacted`                          | `summary`, `keep_from`, `tokens_before`, `carried?`                                     | The model now sees `summary`, then events from index `keep_from`. `carried` is its "already carried out" list, carried forward by the next compaction                               |
| `job_started`                                | `reply`, `job`, `name`                                                                  | A background tool's call was handed to a job (its `tool_finished` says so at once)                                                                                                  |
| `job_finished`                               | `job`, `name`, `content`, `is_error`, `untrusted?`, `cost_micros?`                      | The job ended; the model reads it as a `<job_result>`. Stored once per job. `untrusted` taints the turn that reads it ([helpers.md](helpers.md))                                    |
| `stop_requested`                             | `reply?`, `jobs[]`                                                                      | The person pressed Stop on that reply and those jobs. They stop; a result of a named job, or of a job the reply started, opens no reply. Later work is untouched                    |
| `turn_paused`                                | `reply`                                                                                 | Spade paused the open reply for an update or a stop, with nothing of it running. It stays open (the conversation still reads as working) and resumes from its events on start       |
| `wake_set` / `wake_fired` / `wake_cancelled` | `wake`, `reply`, `purpose`, `due_ms?`, `condition?`, `reason` / `cause`, `note?` / `by` | Every timed or event-driven resume: a sleep, a wait, a turn waiting out an outage, a parked job, a task parked for its check. Fires once ([autonomy.md](autonomy.md))               |
| `task_parked` (retired)                      | `reason`, `until_ms?`, `why`                                                            | Stored by earlier builds for a task waiting on a cap. Still read and ignored: when Spade opens the task is planned again                                                            |
| `turn_parked` (retired)                      | `reply`, `until_ms`, `round`, `why`                                                     | Stored by earlier builds for a turn waiting for its endpoint. Still read: the reply stays open across a restart, waits until `until_ms`, and `round` counts toward the backoff      |

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
- **Steering:** a message sent mid-turn is stored at once and the next model call sees it, placed
  after any running tools' results, and after the step it arrived during. A turn finishes only if
  nothing arrived after its last step's prompt was built (`seen`), checked under the same lock that
  decides steer-or-start, so a message is never lost.
- **Call ids:** a provider may reuse ids across steps (`call_0` in every reply); a reused id is
  replaced before the step is stored, so results and approvals never match the wrong call.
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
  failure that may pass (unreachable, `408`, `429`, `5xx`), or a stream is cut by one after it
  started, the turn does not fail. It stores an outage wake, `wake_set {reply, purpose: {kind:
outage, attempt, error}, due_ms}`, and waits for it: 1, 2, 4 … minutes, at most an hour, or
  the endpoint's longer `retry-after` (still at most an hour); the backoff starts again once a
  step of the turn finishes. When it fires (`wake_fired`, with no note) the step is sent again as
  it was, and the three quick tries start again; what a cut stream had shown is dropped, as on a
  resumed pause. As many rounds as it takes. The reply stays open and the bot reads as `sleeping`
  with "The model is not answering; trying again at 14:05 (…)". Stop ends the wait and the
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

## Tools

Spade's own tools are always offered in full, in name order: `web_search` (SearXNG, then Brave),
`web_fetch` (one page as text, a window at a time, refusing local and private addresses),
`todo`, `task_status` (the bot's task state; while `working`, Spade starts its next step after a
reply, [autonomy.md](autonomy.md)), `sleep_until` and `wait_for` (the bot ends its turn and is
woken at a time or by an event; with the deferred `wake_cancel` and the service tools, ADR 0160,
autonomy.md), `research` (a background job that reads many sources and writes a cited report,
[oversight.md](oversight.md)), `helper` (a background job that hands part of the work to a
short-lived helper with a fresh context, in a hidden conversation of its own,
[helpers.md](helpers.md)), the workspace tools and `shell` ([workspace.md](workspace.md)), and `skill_search`,
`skill_load`, `skill_propose` and `skill_feedback`, over Spade's own skill store, which mirrors
ace's library while ace is there and works without it (workspace.md, "Spade's skill store").
Output from `web_search`,
`web_fetch` and most of ace's tools is untrusted, so a write later in that turn asks.

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

## Compaction

Before each model call, if the endpoint's last reported prompt is at least 75% of the budget
(the model's own context window, 200,000 tokens for a model that doesn't say, capped only by
`SPADE_CONTEXT_TOKENS` when the person sets it as a cost choice; ADR 0158), the engine compacts: it cuts
at a person's message sent while no tool call was waiting for its result, so recent turns of about
35% are kept. It asks the conversation's own model for a JSON summary by appending the request to
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
failed). A summary stored before `carried` existed makes the next compaction walk from the start,
once. Compaction is the one place earlier prompt bytes change: the system prompt and
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
| `GET /v1/ace`                                     |                                                   | `{grant: bool, connected: bool}`, never the grant                                                           |

Maintenance details the contract leaves open: `POST` answers at once and the updater polls `GET`
until `running_turns` is 0 (and, for `idle`, `running_jobs` too). For `idle`, `deadline_ms` bounds
the wait for idleness: when it passes first, admission reopens and nothing is paused. For `now`,
it shortens the 30 s a running step gets. If no restart comes within five minutes of every turn
pausing (the updater died), admission reopens by itself. A `POST` while closed replaces the
earlier one. Without a keychain (Linux with no Secret Service) the ace grant is kept in memory
for that run only.

`spade-server --check-migrations <path>` migrates and integrity-checks the SQLite file at `path`
(a copy) and exits 0 if this build can use it, else 1 with one line saying why. It never opens
the data folder.

`POST /v1/conversations/{id}/messages` while a reply is open steers it (`202`).
