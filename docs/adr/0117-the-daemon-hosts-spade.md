# 0117: The daemon hosts Spade

Status: proposed. Date: 2026-11-11. Implements [spade/docs/ace-integration.md](../../spade/docs/ace-integration.md).

## Context

Spade, ace's assistant, is a Rust server in `spade/` that runs on the person's own machine. Every
ace client (desktop, web, iPhone, the relay) already reaches this machine through the daemon, with
the daemon's device scopes deciding what each client may do. Spade has its own local HTTP API
([chat-core.md](../../spade/docs/chat-core.md)) on loopback with a token in its data folder,
which only processes that can read the person's files can use. Spade also needs ace's own tools
(threads, agents, browser, screen) and ace's skill library.

So the daemon owns Spade's process, hands it credentials for ace, and carries client traffic to
it. Clients never talk to Spade directly.

## Decision

### When Spade runs

- The `spade.enabled` setting, global and admin only, off by default. Spade calls paid model
  endpoints, so it never starts on its own.
- And a binary exists. `ACE_SPADE_BIN` names it in development (for example
  `spade/target/release/spade-server`); otherwise it is `spade-server` (`spade-server.exe` on
  Windows) beside the bundled runtime, which releases ship as `bin/node`, so `bin/spade-server`.
  With the setting on and no binary, Spade is `off` with a reason saying it isn't installed.
- The daemon follows the setting live: on starts Spade, off stops it.
- Spade starts in the listener phase, after the listener is up (its environment names the
  daemon's WebSocket address) and after the engine, the MCP server, agent control and projects,
  which its host thread and lease need.

### Its environment

| Variable                                   | Value                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `SPADE_DATA_DIR`                           | `<ACE_HOME>/spade`, created by the daemon with mode 0700                                |
| `SPADE_LISTEN`                             | `127.0.0.1:0`                                                                           |
| `SPADE_ACE_MCP_URL`, `SPADE_ACE_MCP_TOKEN` | the daemon's loopback MCP endpoint and a lease for this run, naming Spade's host thread |
| `SPADE_ACE_URL`, `SPADE_ACE_TOKEN`         | the daemon's loopback WebSocket and the local host token                                |
| `RUST_LOG`                                 | `info`                                                                                  |

Spade inherits the rest of the daemon's environment (PATH, HOME, the person's own `SPADE_*`
settings such as `SPADE_DAILY_CAP_USD`) except ace's `ACE_*` variables. Its stdout and stderr go
to the daemon's log as `spade` lines, cut at 4 KiB each.

Spade runs as an owned process group through the shared process supervisor, so the process
journal kills a Spade left behind by a crashed daemon on the next start, as it does for provider
CLIs.

### Ready

The daemon polls `<SPADE_DATA_DIR>/server.json` every 100 ms. It is ready when the file parses,
its `pid` is the child the daemon started (a file from an earlier run never counts), its address
is `127.0.0.1:<port>`, the token file holds a token, and `GET /health` answers `{"ok":true}`.
Fifteen seconds without that and the daemon stops the child and counts a failure.

### Stop and restart

- Stop is SIGTERM to the process group, then a kill after 5 s. That fits inside the daemon's
  6-second per-service cleanup deadline and its 7-second shutdown deadline. Spade's service
  closes before the settings, engine and MCP services it depends on, so its lease is revoked
  while the MCP endpoint is still there to end its calls.
- A run that ends on its own is a failure: `spade.status` becomes `failed` with the reason (the
  exit code, the signal, or "Another Spade is already running" for exit code 3), and the daemon
  starts it again after 1 s, doubling each time to at most 60 s. A run that stayed ready for a
  minute resets the backoff, so a crash after a long healthy run waits 1 s again.

### Spade's host thread (decided 2026-11-11)

ace's agent tools act as a thread: a delegation becomes that thread's child, browser and screen use
are owned by it, and notices land in it. So Spade gets a thread of its own to act as.

- **One per daemon.** Spade's host thread is made by the daemon when it starts Spade, before the
  MCP lease, or found if it already exists (`ensureSpadeHostThread`). It is marked `host: "spade"`
  on the thread, and it lives in a hidden project rooted at `<SPADE_DATA_DIR>/workspace`
  (created with mode 0700). That project is a `spade` kind in the project catalog, like the
  hidden `chat` kind of ADR 0099, but the daemon never sends it to clients, so the wire's
  `ProjectKind` is unchanged.
- **Nothing runs in it.** The engine makes it with no session (`HostThreads`). Its root agent is
  announced with one empty finished turn, so it reads idle, never starting or unresponsive. The
  engine refuses every command that would run an agent there with `host_thread`: send, resume,
  limit, switch, merge, goal, queue resume and resend, and fork. When a child settles, its result
  is held for Spade to read with `wait` and `agents_status` instead of waking the host thread.
- **Its ceiling.** The host thread takes the person's `access.defaultMode`, and its provider is
  `providers.default` (a delegation that names no provider gets it, as from any parent). Spade's
  children can never run with more access than a thread the person starts would. When the
  default is full access, the host thread also acts for the person across projects
  (`actsForPerson`), as any full-access top-level thread does.
- **Where children run.** Spade's own project is an empty folder, so a host thread may name a
  local project with `project` (id, path or name, as `projects_find` shows) when it delegates
  without `machine`; the child runs there and stays the host thread's child. Every other agent
  still keeps to its own project, and `project` without `machine` is still refused for them.
- **Hidden.** The Threads panel (its SQL), the client projection's thread list and global search
  leave the host thread out; project lists leave out Spade's project. The children are ordinary
  threads, shown as usual, with the host thread as their parent, so their status rolls up the
  usual way. `spade.status` carries `thread: {id, busy}`, where `busy` means the host thread's
  tree has a child still working or waiting on a person, so Spade's place in the apps can say
  "working".
- **Heals.** A missing or deleted host thread, or a removed Spade project, is made again on the
  next Spade start, without asking anyone. Children delegated before keep their history: deleting
  the host thread, even forced, leaves them in place. No app offers deleting it, since no list
  shows it.

### Credentials for Spade

- **ace's tools.** Each run gets a lease on the daemon's own MCP endpoint, the one provider
  sessions use, naming the host thread and its root agent, with the tool groups a provider
  session gets (`daemonMcpCapabilities`: agents, notify, thread control, automations, projects,
  browser, and devices and screen where this daemon has them). The daemon applies its usual
  per-tool rules, such as the apps agents can't use; Spade's own approval gate runs before every
  write. The lease is revoked when that run ends (crash, stop, `spade.enabled` off) and a new one
  is issued on each start; a daemon restart ends them all, as for every bearer. The bearer lives
  in memory and Spade's environment only.
- **Listing.** Spade sends no `X-Ace-Tools` header, which lists every tool, each with
  `readOnlyHint` and `destructiveHint` stated, so Spade defers tools and maps each tool's risk
  itself. It sends no `X-Ace-Client` header. Simulator (`sim_*`) tools are listed once their
  family opens, announced by `tools/list_changed`.
- **Protocol.** MCP 2025-11-25 with sessions. Spade sends `X-Ace-Notifications: stream` on every
  request: without it the server answers 2025-11-25 statelessly, with no session and no
  list-changed stream. With it, `initialize` returns an `Mcp-Session-Id` and Spade keeps the GET
  stream open for `notifications/tools/list_changed`. One lease holds at most 4 such sessions; a
  fifth `initialize` replaces the oldest.
- **Protocol requests.** `SPADE_ACE_TOKEN` is the daemon's local token (`<ACE_HOME>/daemon-token`).
  Spade uses it on the loopback WebSocket for requests such as `skills.request` (ADR 0103), so
  Spade and the ace apps share one skill library. This is the same authority any local process
  that can read the person's files already has; it never leaves the machine.

### The `spade.*` family

Schema-only in `@ace/protocol` (`spade.ts`), served by the daemon's `spade` socket session:

- `spade.status` → `spade.status.result` `{status: {state, version?, reason?}}`, `state` one of
  `off`, `starting`, `ready`, `failed`. After asking, that socket receives `spade.status.changed`
  on every change. Needs read; a device without it is told Spade is off.
- `spade.http` `{requestId, method, path, body?}` → `spade.http.result` with
  `result: {kind: "response", status, body}` or `{kind: "error", code, message}`. `GET` needs
  read; `POST`, `PUT`, `PATCH` and `DELETE` need operate. The daemon adds Spade's token and passes
  the body through as text.
- `spade.live.subscribe` `{requestId, path}` opens one of Spade's server-sent event streams;
  each event arrives as `spade.live.frame` `{requestId, event, data}` with `data` as Spade wrote
  it. `spade.live.ended` `{requestId, reason, status?}` closes it: `restarted` when the daemon
  stops or restarts Spade, `closed` when Spade ends the stream (a crash may report either),
  `unsubscribed`, `refused` with Spade's HTTP status, or a refusal (`forbidden`, `invalid_path`,
  `unavailable`, `limit`, `too_large`). The client resubscribes with its last `seq`.
  `spade.live.unsubscribe` `{requestId}` ends a stream; closing the socket ends all of them.
  Sixteen streams per socket. Live needs read.

Rules the daemon enforces before anything reaches Spade:

- **Paths.** Only `/v1/...` with an optional query: no dot segments, empty segments, fragments,
  backslashes, whitespace, encoded `.`, `/`, `\` or NUL, or broken escapes. Live paths must end in
  `/live`. So no client reaches `/health` or anything outside the API.
- **Sizes.** Request bodies at most 512 KiB, so a request fits the daemon's 1 MiB inbound frame;
  response bodies and each live event at most 1 MiB. A larger answer is `too_large`, never cut.
- **Time.** A `spade.http` request gives up after 60 s with `failed`.

## Consequences

- Every client reaches Spade with the same scopes, pairing and relay it already uses for the
  daemon; Spade needs no listener of its own beyond loopback.
- The daemon interprets nothing Spade sends: Spade's API can grow without protocol changes.
  Bodies are text in the protocol; clients parse them with Spade's own schemas.
- Spade's crash or absence never affects the daemon: the service always starts, and Spade's state
  is reported only through `spade.status`.
- Spade's work shows up as ordinary threads that have Spade's hidden host thread as their parent.
  The host thread stays out of every list, and its tree's state reaches the apps through
  `spade.status`.

## Changes from the integration contract

- `spade.http.result` wraps the answer in `result` (`response` or `error`) instead of a bare
  `{status, body}`, so a refusal before Spade (scope, path, Spade not ready) has its own code.
- `spade.status.changed` goes to sockets that have asked `spade.status`, not to every socket.
- `spade.live.ended` has more reasons than the contract lists, and `status` for `refused`.
- Delegations from a host thread may name a local `project` without `machine`. The contract had
  children run in the caller's own project, and Spade's is an empty folder, so without this its
  work could never reach the person's code. No other caller gains this.
