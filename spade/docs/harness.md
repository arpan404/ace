# The harness (agent loop)

Date: 2026-11-11. How a turn runs, as built in `spade-core` (decisions, no I/O) and
`spade-server` (the engine and API). Extends [chat-core.md](chat-core.md).

## Events added for turns

| Type                             | Fields                                                                   | Meaning                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message`                   | `text`, `context?`                                                       | `context` (time, memories) is fixed when stored, so the prompt rebuilds to the same bytes                                                                                           |
| `skills_indexed`                 | `text`                                                                   | The skill index, fixed at the first turn                                                                                                                                            |
| `memory_indexed`                 | `text`                                                                   | The notes index for the cached top, fixed before the first model call and after each compaction (memory.md)                                                                         |
| `question_asked`                 | `reply`, `call_id`, `question`                                           | `ask_user` is waiting for the person's next message (memory.md)                                                                                                                     |
| `step_finished`                  | `reply`, `text`, `calls[]`, `thoughts[]`, `usage`, `cost_micros`, `seen` | One model call ended. `thoughts` are kept whole (signed and redacted thinking, `reasoning_content`) and sent back as they came; `seen` is how many events its prompt was built from |
| `approval_requested`             | `reply`, `call_id`, `name`, `arguments`                                  | The gate is waiting on the person                                                                                                                                                   |
| `approval_answered`              | `reply`, `call_id`, `allowed`, `always`                                  | `always` allows that tool for the rest of the conversation                                                                                                                          |
| `tool_started` / `tool_finished` | `reply`, `call_id`, `name`, (`content`, `is_error`)                      | A tool ran                                                                                                                                                                          |
| `context_compacted`              | `summary`, `keep_from`, `tokens_before`                                  | The model now sees `summary`, then events from index `keep_from`                                                                                                                    |
| `job_started`                    | `reply`, `job`, `name`                                                   | A background tool's call was handed to a job (its `tool_finished` says so at once)                                                                                                  |
| `job_finished`                   | `job`, `name`, `content`, `is_error`                                     | The job ended; the model reads it as a `<job_result>`                                                                                                                               |
| `stop_requested`                 | `reply?`, `jobs[]`                                                       | The person pressed Stop on that reply and those jobs. They stop; a result of a named job, or of a job the reply started, opens no reply. Later work is untouched                    |
| `turn_paused`                    | `reply`                                                                  | Spade paused the open reply for an update or a stop, with nothing of it running. It stays open (the conversation still reads as working) and resumes from its events on start       |

`reply_finished` closes a turn whose last step made no tool calls; its `cost_micros` is the
turn's total.

## How a turn runs

`spade_core::turn::next_step(events)` decides, from stored events only:

- **Call the model** when the last step's calls all have results (or there is no step yet). The
  prompt is `context::prompt`: Spade's rules and the frozen skill index, the offered tools (core
  tools in name order, plus `tool_search` and `call_tool` when any tool is deferred), then the
  conversation. It only ever grows at the end.
- **Handle calls** otherwise: each open call is new (to the gate), awaiting, allowed, declined or
  running. The gate runs reads; asks for writes unless allowed always; always asks for
  destructive calls and for any write in a turn that read untrusted output (`web_search`,
  `web_fetch`, email). Allowed calls run in parallel (at most 4) with a timeout; results are cut
  to 20,000 characters. A declined call returns "The person declined this action."
- **Steering:** a message sent mid-turn is stored at once and the next model call sees it, placed
  after any running tools' results, and after the step it arrived during. A turn finishes only if
  nothing arrived after its last step's prompt was built (`seen`), checked under the same lock that
  decides steer-or-start, so a message is never lost.
- **Call ids:** a provider may reuse ids across steps (`call_0` in every reply); a reused id is
  replaced before the step is stored, so results and approvals never match the wrong call.
- **Background tools:** a tool marked `background` answers its call at once and runs as a job
  (at most 30 minutes). Its result is delivered like a message: it steers the open reply or starts a
  new one. Stop cancels jobs and records them stopped without starting a turn; after a restart each
  lost job is delivered as "unknown outcome". The conversation list shows `jobs` running, so a
  conversation never reads as idle while one is out.
- **Stop** cancels the model stream and running tools; calls left without a result are answered
  "not run" in later prompts.
- **Limits:** 30 steps, $2 per turn, the daily cap; each ends the turn with `reply_failed` and a
  reason.
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
`todo`, and, when Spade knows where ace is (`SPADE_ACE_HOME`), `skill_search` and `skill_load`
(they say ace is away while it is). Output from `web_search`,
`web_fetch` and most of ace's tools is untrusted, so a write later in that turn asks.

ace's tools (threads, agents, browser, screen, automations) come from the daemon's MCP endpoint
and can change while Spade runs. All of them are deferred: the model finds them with
`tool_search` and runs them through `call_tool`, so the offered list never changes and the cached
prompt top stays valid. Their risk comes from their annotations (unlabelled means write); ace's
`wait` runs as a background job. When every search backend fails and ace is there, `web_search`
tells the model to have an ace agent search on the cheapest model the person has.

Connectors (the person's apps through their own remote MCP servers, [connectors.md](connectors.md))
are offered the same way: deferred, named `<connector>__<tool>`, risk from their annotations,
output untrusted, and only to bots the person allowed them.

Each conversation gets a skill index (up to 40 skills by name, manual ones left out) frozen into
its instructions before its first model call; skills added later are found with `skill_search`.

## Compaction

Before each model call, if the endpoint's last reported prompt is at least 75% of the budget
(the model's context window or 200,000 tokens, whichever is smaller), the engine compacts: it cuts
at a person's message sent while no tool call was waiting for its result, so recent turns of about
35% are kept. It asks the conversation's own model for a JSON summary by appending the request to
the current prompt with the same tools (no typed-output option, which would change the request and
miss the cache), counts that call's cost like any other, appends every write already carried out
with its call id and exact arguments (from the events, never the summary), and stores
`context_compacted`. Compaction is the one place earlier prompt bytes change: the system prompt and
tools stay cached, the conversation before the cut becomes the summary. If the summary fails, older turns are left out with a note saying
so. `POST /v1/conversations/{id}/compact` with an optional `{"focus": "…"}` compacts between
turns (409 mid-reply).

## API added

| Method and path                                   | Body                   | Answer                                                                                     |
| ------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `POST /v1/conversations/{id}/approvals/{call_id}` | `{allowed, always?}`   | `202`; `409` if that call is not waiting                                                   |
| `POST /v1/conversations/{id}/compact`             | `{focus?}`             | `204`; `409` mid-reply or nothing to compact                                               |
| `GET /v1/models`                                  |                        | The person's endpoints and models, presets, the fast model ([agents.md](agents.md))        |
| `PUT /v1/keys/{endpoint}`                         | `{key}`                | `204`; stored in the OS keychain, never returned                                           |
| `DELETE /v1/keys/{endpoint}`                      |                        | `204`; `404` if none                                                                       |
| `POST /v1/maintenance`                            | `{mode, deadline_ms?}` | `202` with the state below; closes admission and starts pausing. `400` for an unknown mode |
| `GET /v1/maintenance`                             |                        | `{admission: "open"\|"closed", running_turns, running_jobs}`                               |
| `DELETE /v1/maintenance`                          |                        | `200` with the state; reopens admission, paused turns carry on                             |
| `PUT /v1/ace`                                     | `{grant}`              | `204`; kept in the keychain (account `ace:grant`), used at once                            |
| `DELETE /v1/ace`                                  |                        | `204`; forgets the grant and disconnects                                                   |
| `GET /v1/ace`                                     |                        | `{grant: bool, connected: bool}`, never the grant                                          |

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
