# The harness (agent loop)

Date: 2026-11-11. How a turn runs, as built in `spade-core` (decisions, no I/O) and
`spade-server` (the engine and API). Extends [chat-core.md](chat-core.md).

## Events added for turns

| Type                             | Fields                                                             | Meaning                                                                                   |
| -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `user_message`                   | `text`, `context?`                                                 | `context` (time, memories) is fixed when stored, so the prompt rebuilds to the same bytes |
| `skills_indexed`                 | `text`                                                             | The skill index, fixed at the first turn                                                  |
| `step_finished`                  | `reply`, `text`, `calls[]`, `signatures[]`, `usage`, `cost_micros` | One model call ended                                                                      |
| `approval_requested`             | `reply`, `call_id`, `name`, `arguments`                            | The gate is waiting on the person                                                         |
| `approval_answered`              | `reply`, `call_id`, `allowed`, `always`                            | `always` allows that tool for the rest of the conversation                                |
| `tool_started` / `tool_finished` | `reply`, `call_id`, `name`, (`content`, `is_error`)                | A tool ran                                                                                |
| `context_compacted`              | `summary`, `keep_from`, `tokens_before`                            | The model now sees `summary`, then events from index `keep_from`                          |

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
  after any running tools' results. A turn finishes only if no message arrived after its last step,
  checked under the same lock that decides steer-or-start, so a message is never lost.
- **Stop** cancels the model stream and running tools; calls left without a result are answered
  "not run" in later prompts.
- **Limits:** 30 steps, $2 per turn, the daily cap; each ends the turn with `reply_failed` and a
  reason.
- **Restart:** a turn cut off mid-stream or mid-tool closes as `reply_interrupted`; a turn only
  waiting for an approval resumes.

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

| Method and path                                   | Body                 | Answer                                                                       |
| ------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `POST /v1/conversations/{id}/approvals/{call_id}` | `{allowed, always?}` | `202`; `409` if that call is not waiting                                     |
| `POST /v1/conversations/{id}/compact`             | `{focus?}`           | `204`; `409` mid-reply or nothing to compact                                 |
| `GET /v1/models`                                  |                      | Endpoints (`needs_key`, `key_set`, models), roles, whether a keychain exists |
| `PUT /v1/keys/{endpoint}`                         | `{key}`              | `204`; stored in the OS keychain, never returned                             |
| `DELETE /v1/keys/{endpoint}`                      |                      | `204`; `404` if none                                                         |

`POST /v1/conversations/{id}/messages` while a reply is open steers it (`202`).
