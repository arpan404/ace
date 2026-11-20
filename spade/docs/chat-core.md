# Chat core (step 1)

Spade runs on the person's own machine beside the ace daemon. Step 1 is one person chatting with
Spade: conversations, streamed replies, Stop, resume after a reconnect or a restart, and what each
reply cost. Tools, memory and channels come later and build on these events.

## Crates

| Crate           | Job                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `spade-core`    | Pure: conversation events, folding them into a transcript, prompt building, spending, progress checkpoints, titles |
| `spade-store`   | SQLite: conversations, the event log, the usage ledger                                                             |
| `spade-models`  | Model calls (existing)                                                                                             |
| `spade-server`  | The local API and the reply engine                                                                                 |
| `spade-testkit` | Test-only fake model endpoint shared by the crates' tests                                                          |

## Events

Each conversation is an append-only log of numbered events (`seq` from 1). Stored as JSON with a
`type` field; an unknown type read back is kept as raw JSON, never dropped.

| Type                | Fields                                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_message`      | `text`                                                            | The person wrote                                                                                                                                                                                                                                                                                                                                                                                       |
| `reply_started`     | `reply`, `model`                                                  | Spade began answering                                                                                                                                                                                                                                                                                                                                                                                  |
| `reply_progress`    | `reply`, `text`                                                   | Checkpoint of the reply so far (at most every 500 ms)                                                                                                                                                                                                                                                                                                                                                  |
| `reply_finished`    | `reply`, `text`, `input_tokens?`, `output_tokens?`, `cost_micros` | Complete                                                                                                                                                                                                                                                                                                                                                                                               |
| `reply_stopped`     | `reply`, `text`                                                   | The person pressed Stop; `text` is what arrived                                                                                                                                                                                                                                                                                                                                                        |
| `reply_failed`      | `reply`, `text`, `error`, `kind`, `endpoint`?                     | The model call failed; `text` is what arrived; `kind` is `unreachable`, `key`, `rate_limited`, `model`, `no_model` (the bot has no model it can use: none chosen yet, or its model is no longer on the person's endpoints) or `other` (missing or unknown reads as `other`; `cap`, from builds with spending caps, reads as finished for the task); `endpoint` names the endpoint when it was to blame |
| `reply_interrupted` | `reply`, `text`                                                   | Spade restarted mid-reply; `text` is the last checkpoint                                                                                                                                                                                                                                                                                                                                               |
| `reply_retried`     | `reply`                                                           | The person pressed Try again on `reply`, the last reply, which failed. Stored in one write with the `reply_started` that takes its place; clients show the new reply instead of the failure                                                                                                                                                                                                            |
| `renamed`           | `title`                                                           | New title                                                                                                                                                                                                                                                                                                                                                                                              |
| `agent_configured`  | `task`, `model`                                                   | The agent's task or model changed, from the next turn                                                                                                                                                                                                                                                                                                                                                  |

A reply is open from `reply_started` until one of finished, stopped, failed or interrupted. At most
one reply is open per conversation. On startup Spade closes every open reply a crash cut off with
`reply_interrupted`, so nothing is ever shown as still answering after a restart. A reply paused
for a planned restart (`turn_paused`, see [harness.md](harness.md)) instead carries on.

Every step of a reply names it: `step_finished`, `tool_started`, `tool_finished`,
`approval_requested`, `approval_answered`, `call_reviewed`, `job_started` and `question_asked` all
carry the `reply` they belong to, the same id as its `reply_started` and closing event, whether
the person allowed the call, it was always allowed, the access level let it run or the reviewer
approved it. A client folds a reply's steps under it by that field; it needs no other link.

**Try again** answers a failed reply's turn once more, in place: from the same history, on the
bot's model now (the person may just have chosen one), with nothing the person sent posted again.
The words the failed call left unfinished give way to the new reply: neither the chat nor the
model reads them again, so the answer never shows twice; what the reply's finished steps said and
did stays.
Only the conversation's last reply, and only while it failed and nothing is open. A message sent
to a bot with no model yet is refused (`409`, saying to choose one), so nothing is posted that
nothing could answer.

Steering is the default: a `user_message` sent while a reply is open joins that turn. It is
stored at once, and the next model call in the turn (after the current call ends, or at the next
tool step) sees it, so the turn carries on instead of ending.

## API

Local HTTP on `SPADE_LISTEN` (loopback). Every request except `/health` carries
`Authorization: Bearer <token>`; the token is in `<data dir>/token` (mode 0600), written at
startup, so only processes that can read the person's files can talk to Spade.

| Method and path                             | Body      | Answer                                                                                              |
| ------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `GET /health`                               |           | `{"ok":true,"version","api"}`; `api` is the HTTP API version (1)                                    |
| `GET /v1/conversations`                     |           | `[{id, title, updated_at, answering}]`, newest first                                                |
| `POST /v1/conversations`                    |           | `410`: each agent has one conversation, created with it ([agents.md](agents.md))                    |
| `GET /v1/conversations/{id}/events?after=N` |           | `[{seq, at, event}]` after `seq` N                                                                  |
| `POST /v1/conversations/{id}/messages`      | `{text}`  | `202`; while a reply is open the message steers it                                                  |
| `POST /v1/conversations/{id}/stop`          |           | `202`; `404` when nothing is answering                                                              |
| `POST /v1/conversations/{id}/retry`         | `{reply}` | `202`: Try again, below; `409` when `reply` isn't the last reply or didn't fail, or a reply is open |
| `GET /v1/conversations/{id}/live?after=N`   |           | Server-sent events, below                                                                           |

Live stream frames (`event:` name, JSON `data:`):

- `stored`: `{seq, at, event}` for each stored event after N, then each new one.
- `snapshot`: `{reply, text}` once at connect when a reply is open: everything received so far.
- `delta`: `{reply, text}` each new piece of a reply. Not stored; checkpoints and the closing event
  are.
- `seen`: `{seq}` when the person marks the conversation seen, on this device or another
  ([agents.md](agents.md), Seen). Not stored.

A client loads `events`, opens `live` with the last `seq`, and appends. After a reconnect it does the
same; `snapshot` restores any reply text newer than the last checkpoint.

## Spending

The presets in `config/models.json` give priced models a price per million input and output tokens, with cache read and write prices. Each finished
reply records its cost in the usage ledger. It is information only: Spade has no spending limits
([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md)), and `SPADE_DAILY_CAP_USD` is no longer read.

## Settings

| Variable                | Default | Meaning                                                        |
| ----------------------- | ------- | -------------------------------------------------------------- |
| `SPADE_DATA_DIR`        | `data`  | Where `spade.sqlite` and `token` live                          |
| `SPADE_PARALLEL_TOOLS`  | `16`    | Tool calls of one step run at once                             |
| `SPADE_HELPERS_AT_ONCE` | `16`    | Helpers of one bot run at once                                 |
| `SPADE_CONTEXT_TOKENS`  | unset   | Compact before this many prompt tokens even on a larger window |
| model settings          |         | See README                                                     |
