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

  stdout and stderr go to the daemon's log, tagged `spade`.

- **Model catalogue.** If `<SPADE_DATA_DIR>/models.json` does not exist, Spade writes its built-in
  default there on first start; `SPADE_MODEL_CATALOG` still overrides the path.
- **One instance.** Spade holds `<SPADE_DATA_DIR>/lock`; a second instance exits with code 3.
- **Ready.** After binding, Spade writes `<SPADE_DATA_DIR>/token` (mode 0600) and then
  `<SPADE_DATA_DIR>/server.json` atomically: `{"address":"127.0.0.1:PORT","pid":1234,"version":"0.1.0"}`.
  The daemon waits for a `server.json` whose `pid` is its child, then `GET /health`.
- **Stop.** SIGTERM; Spade finishes open requests and exits within 5 seconds, or the daemon kills
  it. The daemon restarts a crashed Spade with backoff (1 s, doubling, at most 60 s) and reports
  each failure.

## Clients reach Spade through the daemon

New request family in `@ace/protocol`, served by the daemon:

- `spade.status` → `{state: "off" | "starting" | "ready" | "failed", version?, reason?}`, with
  `spade.status.changed` pushed on every change.
- `spade.http` `{requestId, method, path, body?}` → `{status, body}`. The daemon forwards it to
  Spade's HTTP API with Spade's token. `path` must start with `/v1/`; `GET` needs the device read
  scope, every other method needs operate.
- `spade.live.subscribe` `{requestId, path}` (a `/v1/.../live?after=N` path) → `spade.live.frame`
  `{requestId, event, data}` for each server-sent event, and `spade.live.ended`
  `{requestId, reason}` when the stream closes (Spade restarted, unsubscribed, disconnected). The
  client resubscribes with its last `seq`. `spade.live.unsubscribe` `{requestId}` ends it.

The daemon passes bodies through without interpreting them; Spade owns their schemas (see
[chat-core.md](chat-core.md)). Sizes are capped like other protocol frames.

## Spade uses ace's tools through the daemon

- **ace tools** (threads, agent status, delegation, browser, screen, notifications, automations):
  Spade is an MCP client of the daemon's loopback MCP endpoint, using `SPADE_ACE_MCP_URL` and
  `SPADE_ACE_MCP_TOKEN`. The daemon applies its usual scopes; Spade's approval gate runs before
  every write.
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
- `delegate`: each task without a `requestId` gets `<conversation>.<call>.<index>`, so a retried
  call, even after a restart, returns the same child. Children are ordinary threads under Spade's
  host thread; a child finishing does not wake anything, so Spade reads results with `wait` (run
  as a background job, up to ten minutes) or `agents_status`.
- When every web search backend fails, `web_search` tells the model to ask an ace agent on the
  cheapest model the person has to search instead.
