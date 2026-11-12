# Chat core (step 1)

Spade runs on the person's own machine beside the ace daemon. Step 1 is one person chatting with
Spade: conversations, streamed replies, Stop, resume after a reconnect or a restart, and a daily
spending cap. Tools, memory and channels come later and build on these events.

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

| Type                | Fields                                                            | Meaning                                                  |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `user_message`      | `text`                                                            | The person wrote                                         |
| `reply_started`     | `reply`, `model`                                                  | Spade began answering                                    |
| `reply_progress`    | `reply`, `text`                                                   | Checkpoint of the reply so far (at most every 500 ms)    |
| `reply_finished`    | `reply`, `text`, `input_tokens?`, `output_tokens?`, `cost_micros` | Complete                                                 |
| `reply_stopped`     | `reply`, `text`                                                   | The person pressed Stop; `text` is what arrived          |
| `reply_failed`      | `reply`, `text`, `error`                                          | The model call failed; `text` is what arrived            |
| `reply_interrupted` | `reply`, `text`                                                   | Spade restarted mid-reply; `text` is the last checkpoint |
| `renamed`           | `title`                                                           | New title                                                |

A reply is open from `reply_started` until one of finished, stopped, failed or interrupted. At most
one reply is open per conversation. On startup Spade closes every open reply a crash cut off with
`reply_interrupted`, so nothing is ever shown as still answering after a restart. A reply paused
for a planned restart (`turn_paused`, see [harness.md](harness.md)) instead carries on.

Steering is the default: a `user_message` sent while a reply is open joins that turn. It is
stored at once, and the next model call in the turn (after the current call ends, or at the next
tool step) sees it, so the turn carries on instead of ending.

## API

Local HTTP on `SPADE_LISTEN` (loopback). Every request except `/health` carries
`Authorization: Bearer <token>`; the token is in `<data dir>/token` (mode 0600), written at
startup, so only processes that can read the person's files can talk to Spade.

| Method and path                             | Body                  | Answer                                                                                                                             |
| ------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                               |                       | `{"ok":true,"version","api"}`; `api` is the HTTP API version (1)                                                                   |
| `GET /v1/conversations`                     |                       | `[{id, title, updated_at, answering, client_key}]`, newest first                                                                   |
| `POST /v1/conversations`                    | `{text, client_key?}` | `201 {id}`; the message is sent and a reply starts. `200 {id}` when a conversation already has `client_key`: nothing is sent again |
| `GET /v1/conversations/{id}/events?after=N` |                       | `[{seq, at, event}]` after `seq` N                                                                                                 |
| `POST /v1/conversations/{id}/messages`      | `{text}`              | `202`; while a reply is open the message steers it; `402` when today's cap is spent                                                |
| `POST /v1/conversations/{id}/stop`          |                       | `202`; `404` when nothing is answering                                                                                             |
| `GET /v1/conversations/{id}/live?after=N`   |                       | Server-sent events, below                                                                                                          |

Live stream frames (`event:` name, JSON `data:`):

- `stored`: `{seq, at, event}` for each stored event after N, then each new one.
- `snapshot`: `{reply, text}` once at connect when a reply is open: everything received so far.
- `delta`: `{reply, text}` each new piece of a reply. Not stored; checkpoints and the closing event
  are.

`client_key` is the client's own key for one start (a UUID; 1 to 128 letters, digits, `-` or
`_`, else `400`). A client whose start got no answer sends it again with the same key and gets the
conversation it made, never a second one. Spade before this ignores the field and lists no key.

A client loads `events`, opens `live` with the last `seq`, and appends. After a reconnect it does the
same; `snapshot` restores any reply text newer than the last checkpoint.

## Spending

`config/models.json` gives priced models a price per million input and output tokens, with cache read and write prices. Each finished
reply records its cost in the usage ledger. `SPADE_DAILY_CAP_USD` (default 5) caps a day's spend in
the machine's local day; a message after the cap is refused with `402` and no model is called.

## Settings

| Variable              | Default | Meaning                               |
| --------------------- | ------- | ------------------------------------- |
| `SPADE_DATA_DIR`      | `data`  | Where `spade.sqlite` and `token` live |
| `SPADE_DAILY_CAP_USD` | `5`     | Daily spending cap                    |
| model settings        |         | See README                            |
