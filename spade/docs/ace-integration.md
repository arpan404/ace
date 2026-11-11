# How ace and Spade fit together

Date: 2026-11-11. Status: the contract the build follows. Spade runs on the person's own machine
as its own per-user service beside the ace daemon ([ADR 0123](../../docs/adr/0123-spade-runs-as-its-own-service.md)).
The daemon never starts or stops it. The desktop app talks to Spade directly; every other client
(the web app in a browser, the iPhone, other machines) reaches it through the daemon's `spade.*`
family. Spade uses ace's tools as a client, with a durable grant, and keeps working while the
daemon is away.

## The Spade service

- **Binary.** Each release carries `spade-server` for its target. Installing or updating copies it
  to `<ACE_HOME>/releases/spade/<version>/spade-server` and points
  `<ACE_HOME>/releases/spade/current` at that folder; the service runs
  `<ACE_HOME>/releases/spade/current/spade-server`. In development, `ACE_SPADE_BIN` names a build
  (for example `spade/target/release/spade-server`) and `ace spade on` registers that instead.
- **Registration** (`@ace/service`, beside the daemon's): launchd `dev.ace.next.spade` (RunAtLoad,
  KeepAlive, ThrottleInterval as the daemon's), systemd `ace-next-spade.service` (`--user`,
  `Restart=on-failure`, `RestartSec=1`), Windows Task Scheduler task `ace-next-spade` (logon
  trigger, restart on failure). The service's environment is exactly `SPADE_DATA_DIR=<ACE_HOME>/spade`,
  `SPADE_ACE_HOME=<ACE_HOME>`, `SPADE_LISTEN=127.0.0.1:0` and `RUST_LOG=info`; logs go to
  `<ACE_HOME>/logs/spade.log` (rotated like the daemon's). The `@ace/service` API:
  `spadeServicePlan(home, platform)`, `installSpadeService(plan)`, `removeSpadeService(plan)`,
  `spadeServiceState(plan)` (`absent`, `stopped`, `running`).
- **On and off.** `spade.enabled` is the one switch. Turning it on (Settings or `ace spade on`)
  installs the binary copy if missing, registers and starts the service, then makes Spade's grant
  (below). Turning it off revokes the grant and removes the service. Builds with
  `DISABLE_SPADE=1` never register it.
- **One instance.** Spade holds `<SPADE_DATA_DIR>/lock`; a second instance exits with code 3, and
  the service manager does not restart a code-3 exit in a tight loop (its throttle applies).
- **Ready.** After binding, Spade writes `<SPADE_DATA_DIR>/token` (mode 0600, rewritten on every
  start) and then `<SPADE_DATA_DIR>/server.json` atomically:
  `{"address":"127.0.0.1:PORT","pid":1234,"version":"0.4.0","api":1}`. `GET /health` answers
  `{"ok":true,"version":"0.4.0","api":1}` without a token. `api` is Spade's HTTP API version;
  clients accept the current and previous one.
- **Stop.** SIGTERM: Spade closes admission, lets a running model step finish (up to 5 s for a
  plain stop), records open turns as paused (`turn_paused`), ends its live streams and exits. On
  start, each paused turn resumes from its stored events.

## Updates

Every updater path installs both programs and never stops both at once: the desktop restart
(ADR 0091), `ace update apply` (ADR 0041) and the machine update (ADR 0113). The daemon is swapped
first, then Spade:

1. `POST /v1/maintenance` `{"mode":"idle"|"now","deadline_ms":N}` (Spade's token) closes
   admission: messages are still stored and answered after the restart; no turn starts.
   `GET /v1/maintenance` answers `{"admission":"open"|"closed","running_turns":N,"running_jobs":N}`;
   `DELETE /v1/maintenance` reopens admission (an aborted update).
2. `idle` waits until no turn runs and no background job runs; `now` waits only for running model
   steps (up to 30 s). Then each open turn is recorded paused.
3. The updater copies the new binary to `releases/spade/<version>/`, runs
   `spade-server --check-migrations <snapshot>` against a SQLite backup of
   `<SPADE_DATA_DIR>/spade.sqlite` (exit 0: the new version can open it), flips `current` and
   restarts the service. Any failure keeps the old `current`, reopens admission and reports why.
4. The new Spade resumes paused turns. A background job that was still running in `now` mode is
   reported as Spade reports a lost job ("unknown outcome").

## Spade's grant for ace

- **Made by the daemon** when Spade is turned on: a durable `spade` grant (stored, listed and
  revoked like ADR 0122's grants, surviving restarts), bound to Spade's host thread, whose lease is
  the provider-session tool set (see "How Spade calls ace's tools"). Turning Spade off or revoking
  the grant ends it.
- **Handed to Spade** over Spade's local API, authenticated with Spade's token file:
  `PUT /v1/ace` `{"grant":"<token>"}` → 204. Spade stores it in the OS keychain (service
  `dev.acehq.spade`, account `ace:grant`), never in its database or logs, and starts using it.
  `DELETE /v1/ace` forgets it. `GET /v1/ace` answers `{"grant":true|false,"connected":bool}`
  and never returns the token. If Spade is not running when the grant is made, the daemon hands it
  over when Spade's `server.json` next appears.
- **Finding the daemon.** Spade reads `<SPADE_ACE_HOME>/daemon-endpoint` (the daemon's
  `http://127.0.0.1:PORT`) each time it connects: MCP at `<endpoint>/mcp` with the grant as the
  bearer; protocol requests (`skills.request`) over `ws://` on the same port, authenticated with
  `<SPADE_ACE_HOME>/daemon-token`. While the file is missing or the daemon refuses, Spade retries
  with backoff (1 s, doubling, at most 30 s) and its ace tools are absent.
- In development, `SPADE_ACE_MCP_URL`, `SPADE_ACE_MCP_TOKEN`, `SPADE_ACE_URL` and
  `SPADE_ACE_TOKEN` still override the above.

## The desktop app talks to Spade directly

The desktop main process reads `<ACE_HOME>/spade/server.json` and the token file, watches them for
changes, and exposes `window.aceDesktop.spade` through the preload bridge:
`{ endpoint(): Promise<{ address: string; token: string; api: number } | null> }`. The renderer
calls Spade's HTTP API and live stream at that address with the token; when it is `null` or a
request fails to connect, it falls back to the daemon's `spade.*` family. The token never leaves
the desktop process tree and is never persisted by the renderer.

## Other clients reach Spade through the daemon

New request family in `@ace/protocol`, served by the daemon:

- `spade.status` → `spade.status.result` `{status: {state: "off" | "starting" | "ready" |
"failed", version?, reason?}}`; afterwards that socket gets `spade.status.changed` on every
  change. The daemon no longer runs Spade: it reads the state from the service's registration,
  `server.json` and `GET /health` (`off` when the service is absent, `starting` until `/health`
  answers, `failed` with the reason when the service is registered but Spade isn't answering).
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

## Spade uses ace's tools

- **ace tools** (threads, agent status and messages, delegation, browser, screen and computer
  use, notifications, automations, skills and guides): Spade is an MCP client of the daemon's
  loopback MCP endpoint, with its grant (see "Spade's grant for ace"). The lease is a
  provider session's: operate scope, every agent tool group, the daemon's usual per-tool rules,
  except `ask` and `browser_request_help`, which wait on the person inside the hidden host
  thread; Spade asks through its own `ask_user`.
  Spade's approval gate runs before every write. The grant lasts across restarts of either
  program and ends when Spade is turned off or the grant is revoked.
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
