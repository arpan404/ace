# How ace and Spade fit together

Date: 2026-11-10. Status: the contract the build follows. Spade runs on the person's own machine
beside the ace daemon. The daemon starts and stops it, hands it credentials for ace's own tools,
and carries every client's traffic to it, so desktop, web, the iPhone and the relay reach Spade
the same way they reach the daemon.

## The Spade process

- **Binary.** `spade-server` from the release bundle (`bin/spade-server`), or `ACE_SPADE_BIN` in
  development (for example `spade/target/release/spade-server`). No binary means Spade is off.
- **Started by the daemon** when Spade is enabled in settings, with this environment:

  | Variable                                   | Value                                                                                               |
  | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
  | `SPADE_DATA_DIR`                           | `<ACE_HOME>/spade` (created by the daemon)                                                          |
  | `SPADE_LISTEN`                             | `127.0.0.1:0` (Spade picks a free port)                                                             |
  | `SPADE_ACE_MCP_URL`, `SPADE_ACE_MCP_TOKEN` | ace's loopback MCP endpoint and a bearer the daemon issues for Spade                                |
  | `SPADE_ACE_URL`, `SPADE_ACE_TOKEN`         | the daemon's loopback WebSocket and the local token, for protocol requests such as `skills.request` |
  | `RUST_LOG`                                 | `info`                                                                                              |

  stdout and stderr go to the daemon's log, tagged `spade`. Spade inherits the rest of the
  daemon's environment, including the person's own `SPADE_*` settings, except `ACE_*`.
  `SPADE_ACE_MCP_URL` is `http://127.0.0.1:PORT/mcp` (MCP Streamable HTTP, protocol
  2025-11-25, the bearer in `Authorization`). Send `X-Ace-Notifications: stream` on every MCP
  request, or the server answers statelessly with no session and no list-changed stream; send no
  `X-Ace-Tools` header, so every tool is listed with its `readOnlyHint` and `destructiveHint`.
  The bearer is new for each Spade run and revoked when the run ends. `SPADE_ACE_URL` is `ws://127.0.0.1:PORT`: send
  `{"type":"hello","protocolVersion":1,"deviceId":"spade","token":"<SPADE_ACE_TOKEN>"}` and wait
  for `welcome` before any request.

- **Model catalogue.** If `<SPADE_DATA_DIR>/models.json` does not exist, Spade writes its built-in
  default there on first start; `SPADE_MODEL_CATALOG` still overrides the path.
- **One instance.** Spade holds `<SPADE_DATA_DIR>/lock`; a second instance exits with code 3.
- **Ready.** After binding, Spade writes `<SPADE_DATA_DIR>/token` (mode 0600) and then
  `<SPADE_DATA_DIR>/server.json` atomically: `{"address":"127.0.0.1:PORT","pid":1234,"version":"0.1.0"}`.
  The daemon waits for a `server.json` whose `pid` is its child, then `GET /health`.
- **Stop.** SIGTERM; Spade finishes open requests, ends its live streams and exits within 5
  seconds, or the daemon kills it. The daemon restarts a crashed Spade with backoff (1 s, doubling, at most 60 s) and reports
  each failure.

## Clients reach Spade through the daemon

New request family in `@ace/protocol`, served by the daemon:

- `spade.status` → `spade.status.result` `{status: {state: "off" | "starting" | "ready" |
"failed", version?, reason?}}`; afterwards that socket gets `spade.status.changed` on every
  change.
- `spade.http` `{requestId, method, path, body?, encoding?, contentType?, parts?}` →
  `spade.http.result` with `result` `{kind: "response", status, body, encoding, contentType?,
parts?}` or `{kind: "error", code, message}` (`forbidden`, `invalid_path`, `unavailable`,
  `too_large`, `invalid_body`, `limit`, `failed`). The daemon forwards it to Spade's HTTP API
  with Spade's token. `path` must start with `/v1/`; `GET` needs the device read scope, every
  other method needs operate. Bodies pass through as bytes:
  - **Encoding.** `encoding` is `"text"` (UTF-8, the default) or `"base64"` (bytes), for the
    request body and every part. `contentType` is sent as `content-type`, `application/json` by
    default.
  - **Large requests.** With `parts: N` (up to 1024) the request has no `body`; it follows in
    `spade.http.part` `{requestId, index, body}` messages, `index` 0 to N - 1 in order, each at
    most 192 Ki characters. A base64 part other than the last holds a multiple of 4 characters,
    and a text part never splits a surrogate pair. The daemon streams the parts to Spade as they
    arrive, with chunked transfer. Send the parts only after `spade.http.open` `{requestId}`
    arrives: it says the daemon took the request; a refusal comes as `spade.http.result` instead. A part out of order or bad base64 ends the request with
    `invalid_body`; 60 s without the next part ends it with `failed`.
  - **Request caps.** `POST /v1/conversations` and `POST /v1/conversations/{id}/messages` take up
    to 56 MiB, room for 8 images of 5 MiB as base64 in JSON. Every other route takes 512 KiB. A
    larger body is refused with `too_large` before Spade sees it.
  - **Answers.** JSON and `text/*` answers come back as `encoding: "text"`; anything else (an
    image) as `encoding: "base64"` with Spade's `contentType`. `GET /v1/images/{sha256}` may
    answer up to 5 MiB; every other route 1 MiB.
  - **Long answers.** An answer longer than 768 Ki characters comes in pieces. `result.body` is
    the first and `result.parts` the count; the client asks for each further piece with
    `spade.http.read` `{requestId, index}` (1 to parts - 1). The daemon answers each with
    `spade.http.chunk` `{requestId, index, body}`, and the whole body is the pieces joined in
    order. The daemon holds the pieces 60 s and lets them go once the last is read; a chunk with
    `gone: true` means they were let go, so send the request again.
- `spade.live.subscribe` `{requestId, path}` (a `/v1/.../live?after=N` path) → `spade.live.frame`
  `{requestId, event, data}` for each server-sent event, and `spade.live.ended`
  `{requestId, reason, status?}` when the stream closes (`restarted`, `closed`, `unsubscribed`,
  `refused` with Spade's status, or a refusal such as `forbidden` or `unavailable`). The client
  resubscribes with its last `seq`. `spade.live.unsubscribe` `{requestId}` ends it.

The daemon passes bodies through without interpreting them; Spade owns their schemas (see
[chat-core.md](chat-core.md)). Caps are per route, as above; each live event is at most 1 MiB.
ADR 0121 records the daemon side.

## Spade uses ace's tools through the daemon

- **ace tools** (threads, agent status and messages, delegation, browser, screen and computer
  use, notifications, automations, skills and guides): Spade is an MCP client of the daemon's
  loopback MCP endpoint, using `SPADE_ACE_MCP_URL` and `SPADE_ACE_MCP_TOKEN`. The lease is a
  provider session's: operate scope, every agent tool group, the daemon's usual per-tool rules,
  except `ask` and `browser_request_help`, which wait on the person inside the hidden host
  thread; Spade asks through its own `ask_user`.
  Spade's approval gate runs before every write. The bearer is new on each start and revoked
  when Spade stops, crashes or is turned off.
- **Spade's host thread.** Spade's calls act as a hidden ace thread the daemon holds for it
  (`spade.status` `thread.id`). What Spade delegates becomes that thread's children: ordinary,
  visible threads. Nothing runs in the host thread itself, so Spade never gets a wake when a
  child finishes: it reads results with `wait` (or `delegate` with `waitSeconds`) and
  `agents_status`. To run a child in one of the person's projects, pass `project` (its id, path
  or name, as `projects_find` shows) with no `machine`; without it the child runs in Spade's own
  empty folder. `spade.status` `thread.busy` is true while any child is still working or waiting
  on the person.
- **Routing results to a conversation.** Each delegation's `requestId` is Spade's own key (1-128
  of `A-Za-z0-9_.-`, unique among the host thread's delegations). Spade uses
  `<conversation>.<call>.<task>` (see below). A retry with the same key and the same task returns the same child,
  so a delegation Spade sent just before a crash is never started twice; the host thread outlives
  Spade's restarts, so this holds across them. The `delegate` reply lists `threadIds` in the order
  of `tasks`: Spade stores `threadId → conversation` from it, and `wait` and `agents_status` name
  each child by that `threadId`. Each running child also needs its own `role` (a name saying what
  and where, such as `Fix-login-toast`): all of Spade's conversations share one host thread, and
  two live children of one parent can't share a role.
- **Skills:** `skills.request` (ADR 0103) over the daemon WebSocket with the local token, for the
  list and each skill's text, so Spade and ace share one skill library.
- **CLI brains (later):** Spade asks the daemon to run a turn on a provider CLI with Spade's tools
  attached; the daemon's existing provider sessions carry it.

## How Spade calls ace's tools

- Every MCP request carries `X-Ace-Notifications: stream` and no `X-Ace-Tools` or
  `X-Ace-Client` header, so Spade gets the full listing with `readOnlyHint` and
  `destructiveHint` and a list-changed stream. The bearer lives in memory only and is new on
  every start.
- The list is fetched at start, on every change notice and every five minutes. Every ace tool is
  offered deferred (found with `tool_search`, run through `call_tool`), so the tools sent to the
  model never change. Risk comes from the annotations; an unlabelled tool is a write.
- A call is never sent twice: a call on an expired session comes back "not run", one cut off after
  sending comes back "unknown outcome" and the model is told to check before retrying.
- `delegate`: every task's `requestId` is scoped to the call as `<conversation>.<call>.<task>`,
  where `<task>` is the model's own id (or the task's index), with characters ace refuses
  replaced, so a retried call, even after a restart, returns the same child and conversations
  never collide. Children are ordinary threads under Spade's host thread and a child finishing
  wakes nothing, so `delegate` runs as a background job that waits for its children (up to ten
  minutes; the conversation shows them as work) and `wait` collects any still running.
- When every web search backend fails, `web_search` tells the model to ask an ace agent on the
  cheapest model the person has to search instead.
