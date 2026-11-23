# 0226: The daemon leaves Bun

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: the owner decided the goal
on 2026-11-23 ("lets move completely from bun backend/server", "start moving sql read write,
transport from daemon to be in rust"); the design is pending the owner.

## Context

The daemon is a Bun program (`runtime/bin/node daemon/ace.mjs`, ADR 0214) that loads one Rust
core as an in-process napi-rs addon (`native/daemon`, ADR 0222 §1). ADRs 0221 to 0225 move the CLI,
the event store, the engine and adapters, git and forge, devices, screens, automations and the MCP
server into that core, each behind the TypeScript interface its tests use. Each of them keeps the
socket server in TypeScript (ADR 0223 §6, ADR 0225 §7), and none of them makes Bun leave the
daemon process.

The owner's goal is a daemon that is a Rust program, with no Bun or JavaScript in its process.
Bun stays shipped only to run what must be JavaScript, as separate children started when needed.
The Claude Agent SDK port stays deferred to the provider-sessions work (ADR 0223, "Decided by the
orchestrator"). Desktop (Electron), web and iOS clients are not part of this.

This ADR does three things: it inventories what is left in TypeScript once ADRs 0221 to 0225 are
done, it decides how the transport (sockets, HTTP, relay, pairing, auth, fan-out) moves, and it
decides when the process inverts from "Bun loads Rust" to "Rust is the program". The transport's
contract is [docs/transport/behaviour.md](../transport/behaviour.md); the builders' guide is
[docs/transport/porting-guide.md](../transport/porting-guide.md).

### What is left after ADRs 0221 to 0225

Counted on `ace/daemon-rust-rewrite` 13e95607e6. `apps/daemon/src` holds 2,914 TypeScript files:
1,327 test files, 125 test-support, fixture, eval and bench files, and **1,462 production
modules (206,727 lines)**. Each production module was assigned to one responsibility by its path
(the script and its rules are in the porting guide, "Counting"). Of them:

| Covered by                                                          | Modules | Lines  |
| ------------------------------------------------------------------- | ------- | ------ |
| ADR 0221, the CLI (`cli/`, utility and diagnostics CLIs)            | 199     | 23,725 |
| ADR 0221 step 7, doctor and triage (`doctor/`, `triage-*`)          | 40      | 4,109  |
| ADR 0222, the store's connection, writer, long-thread reads, format | 47      | 8,439  |
| ADR 0223, the engine (`engine/`, `native-engine/`)                  | 158     | 20,569 |
| ADR 0225, automations (`automation-*`)                              | 11      | 2,452  |
| ADR 0225, devices, screens, locked use (daemon side)                | 19      | 2,241  |
| ADR 0225, the MCP server's daemon side (`tool-result-mcp`, `mcp*`)  | 7       | 1,275  |
| **Covered**                                                         | **481** | 62,810 |

**Left in TypeScript after all five: 981 production modules, 143,917 lines**, grouped below and
listed file by file in [the behaviour guide's inventory](../transport/behaviour.md#11-inventory).

| Left, by responsibility                                                                                                                         | Modules | Lines  | Has an ADR?                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ---------------------------------------------------------------- |
| Machines: `machines/`, `machine-tunnel/`, `machine-update/`, `transfers/`, `parcels/`, `media-relay/`, `files-relay`, `remote-*` jobs           | 144     | 27,389 | no (next in the owner's order, ADR 0222 "Path after the store")  |
| Spade host side, Store (marketplace), Suits, plugins, skills, icons, previews                                                                   | 115     | 16,766 | no                                                               |
| **Transport**: server, sockets, HTTP, relay, pairing, auth, device identity, fan-out                                                            | 89      | 13,154 | **this ADR**                                                     |
| Git and forge callers: `workspace-*`, `pr-*`, `hosted-*`, `forge-*`, `workspace-runtime`                                                        | 80      | 12,393 | ADR 0224 moves the packages; their 57 daemon callers stay TS     |
| Agent-control (`agent-control/`), knowledge, handoff, measurement, html and image publication                                                   | 83      | 12,100 | no (next after the engine)                                       |
| Daemon lifecycle: `index.ts` composition, shutdown, settings, notifications, storage service and workers, verify, terminal service, app updates | 100     | 12,044 | no                                                               |
| Store reads: items, sidebar, thread rows and cache, history index, search shaping, status store, entity windows, previews                       | 79      | 11,200 | ADR 0222 dropped them (1b, 3); this ADR's T4 takes the wire path |
| Providers and accounts: account management, logins, provider status, usage, catalogs, installs                                                  | 81      | 10,911 | no (ADR 0223 moves the adapters, not account management)         |
| Projects and files: `projects`, `project-*`, `files-*`, `files-tool/`, local and linked files, host open                                        | 49      | 8,134  | no                                                               |
| Engine callers: thread creation, commands, asks, models, run checkpoints, loop monitor, liveness                                                | 54      | 6,632  | no (callers of `Engine`)                                         |
| Account and org access: `account-access/`, `org-access/`, `org-host/`, `org-registry/`                                                          | 39      | 5,075  | no                                                               |
| Outside MCP clients (`external-mcp/`, ADR 0122)                                                                                                 | 37      | 4,390  | ADR 0225 keeps it TS until its own move                          |
| Browser glue (`browser-*`, `browsing`, `user-browser`)                                                                                          | 21      | 2,332  | no                                                               |
| Small remainders (devices settings, doctor runs, utility, action errors, automation tools)                                                      | 10      | 1,397  | partly 0225                                                      |

Packages the daemon loads that no ADR moves: 35 of them, 169,364 source lines. The large ones are
`@ace/browser` (33,717), `@ace/client` (22,656; the daemon uses it to reach other machines),
`@ace/marketplace` (16,478), `@ace/commands` (9,314), `@ace/media` (9,094; the TypeScript side of
ace-media), `@ace/service` (7,266; shared with the desktop app), `@ace/files` (6,538),
`@ace/accounts` (6,280) and `@ace/models` (5,590); the full list is in the behaviour guide §11.
`@ace/protocol` (29,833 lines of Zod) is not daemon code: it stays the schema source for every
client, and Rust gets types generated from it (§3).

**What must stay JavaScript, as children.** Found by searching every spawn of the daemon's own
runtime (`process.execPath`) and every JavaScript library that runs a provider's or a person's
code:

| What                                                                                                                                      | Why it must be JavaScript                                                  | Today                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| Cursor SDK host (`packages/adapter-cursor/src/host-entry.ts`) and its API-key login entry (`api-key.ts`, `provider-login-prepare.ts:112`) | `@cursor/sdk` is Cursor's proprietary agent (ADR 0223)                     | already a child on the bundled runtime     |
| Pi's SDK workers: `pi-login-worker.ts` (`pi-login-driver.ts:143`), `pi-credentials-worker.ts` (`provider-kit/src/discovery/pi-sdk.ts:67`) | they load the person's installed Pi package                                | already children                           |
| Claude's metadata host and history fork (`adapter-claude/src/metadata-host.ts`, `fork-worker.ts`)                                         | they call the Agent SDK                                                    | already children                           |
| **Claude's sessions** (`@anthropic-ai/claude-agent-sdk`, `adapter-claude/src/session.ts`)                                                 | the SDK is JavaScript; the Rust stream-json session is deferred (ADR 0223) | **in the daemon process**                  |
| serve-sim (`toolchains.ts:38`, `devices/src/serve-sim-install.ts:74`)                                                                     | an npm tool                                                                | already a child                            |
| Spade bot kit `ace bot init/check/test/dev`                                                                                               | runs the bot's JavaScript (ADR 0221 §7)                                    | the CLI hands over to the bundle           |
| OpenCode plugins (`agent-env-plugin`, `mcp-ready-plugin`) and the Pi extension (`adapter-pi/src/extension.ts`)                            | they run inside the provider's own runtime                                 | files ace ships; ace's Bun never runs them |

Today's JavaScript children that need not stay JavaScript: the Windows process gates run as
`node -e <gate>` (`browser/src/chrome-job.ts:140`, `forge/src/command.ts:72`), which the E2
supervisor replaces; the "Use my Chrome" native-messaging host (`browser-extension/src/install.ts:75`
writes a launcher that runs a JavaScript entry), which becomes an `ace` subcommand like ADR 0225's
M5; the doctor's PTY and SQLite probes (`diagnostics/src/probes.ts:111`, `sqlite.ts:17`), which go
with ADR 0221 step 7; the daemon's own workers (WAL checkpoint, search queries, history
publication, usage and worktree storage workers, file renames and blobs), which become Rust
threads as their owners move. Two TypeScript pieces ADR 0225 §4 kept on purpose, recurrence over
ICU and Zod's wording of rejected tool arguments, block the inversion (question 2).

### Measurements

None were taken for this draft. The owner stopped the profiling run on 2026-11-23 because another
benchmark was running on the same machine (load average 274), and two benches at once corrupt both.
No transport share is claimed here. The measurements this ADR needs, with their exact command
lines, are in the porting guide ("Measurements to schedule"); they run one at a time, when the
owner schedules them.

Recorded numbers that already bear on the transport, from their own reports:

- Daemon bench baseline (`tools/daemon-bench/baseline.json`, darwin-arm64, Bun 1.4.4, median of
  three): idle 1.09% of a core; heap after GC 73 MB at startup, 107 to 111 MB after the turn
  phases; RSS 251 MB at startup. These are totals; the bench does not split them by module.
- Relay channel deflate (`apps/daemon/bench/head-of-line-results/relay.json`, 2026-11-15, load 62
  to 75): 0.02 to 0.12 ms per message of 1.6 to 6.1 KB; event-loop gaps up to 13.7 ms at idle,
  under 0.2 ms of which was deflate.
- Store reads (ADR 0222, Measurements): the sidebar page and thread list spend 68 to 74% of their
  time outside SQLite and `JSON.parse` (schema checks, shaping, copying); thread reads spend
  three quarters or more inside SQLite.
- MCP calls (ADR 0225): SDK and HTTP are 10 to 15% of a call's CPU; Zod about 8%.

### Facts the design must respect

1. **The socket server is a dispatcher over 64 TypeScript services per socket.**
   `createSocketRegistry` (`services/registry.ts`) builds 61 factory sessions plus diagnostics,
   screen and locked use for every authenticated socket. Each implements `SocketService`
   (`services/socket.ts`): `handle(message, device)`, `command` registrations with scopes,
   `binary(frame)`, `welcomed`, `revoked`, `close`. The services reach the daemon through a
   `SocketContext` of about 30 members (authorization, org standing, send, fail). The transport
   can move long before the services do, only if it can hand messages to them.
2. **The black-box tests start the server in process.** 198 test files build the server through
   `socket-test-support.ts`'s `fixture()`, which calls `startServer` in the test's own process
   with a TypeScript `Store` and a stub handler, and drive it over a real WebSocket. At least 52 of
   them inject TypeScript ports into `ServerOptions` (provider statuses, relay, clock, models,
   commands, notifications, locked use, screen and others), and about 130 seed or read the
   `Store` directly. 89 files are `*.server.process.test.ts`. Only three test files start the
   daemon as a separate program (`daemon-launch-test-support.ts`, `daemon-crash-test-support.ts`).
3. **Synchronous `Store.atomic` callers pin the JavaScript thread** (ADR 0222 §3, ADR 0223 §4): 614
   call sites in 176 files share one connection and transaction on the JS thread. While any of
   them exists, the core cannot leave that thread, and the process cannot invert.
4. **Remote sockets use per-message deflate** (`server.ts:254`–`:257`, `compression-policy.ts`):
   RFC 7692 without context takeover, chosen per message by an allowlist. `tungstenite` 0.30, the
   crate the Rust CLI uses, refuses any frame with RSV1 set (`tungstenite-0.30.0/src/protocol/mod.rs:643`),
   so it cannot carry compressed messages in either direction. The relay channel compresses at the
   application level (`deflate-raw` per message inside Noise), which needs no WebSocket extension.
5. **The relay and pairing cryptography is Noise** (`@ace/secure-channel`): `Noise_XX_25519_ChaChaPoly_SHA256`
   for relay streams and `Noise_NK_25519_ChaChaPoly_SHA256` for one-round-trip connects
   (ADR 0155), with test vectors (`noise-nk-vectors.test.ts`, `media-vectors.test.ts`).
6. **Clients are not part of this.** Every byte a client parses, every close code, every HTTP
   status and header, every round trip of the connect sequence stays as it is.

## Decision

### 1. The end state

- One program, `ace-daemon` (`ace-daemon.exe`), built from `native/daemon`: the same crates the
  addon loads today, with a `main` in a new crate, `ace-daemon-bin`. No JavaScript runtime runs
  in its process.
- The addon (`ace-daemon-node`) stays, as the **test host**: the TypeScript tests keep loading the
  same Rust core in process and inject their fakes through its JavaScript ports, as ADRs 0222 to
  0225 already do. So the tests move with the code, they don't multiply: the production program
  and the test host are two thin hosts over one core, and the few tests that start the daemon as a
  program (fact 2) prove the program's own wiring.
- Bun ships only for the children in the table above, started on first need, and only on
  platforms whose features need them.

### 2. The transport: where it runs and which crates

- **`ace-transport`**, a crate in `native/daemon`, owns listeners, TLS, HTTP, the WebSocket layer,
  connection admission and liveness, the outbox, hello and authentication, subscriptions and
  fan-out, the relay host link and Noise, and the routing of every inbound message to its owner.
- **I/O on the core's tokio runtime** (ADR 0223 §4: tokio, two workers): accept, TLS, framing,
  compression, reading and writing. **Protocol decisions on the core's executor**, the single-
  threaded pump of ADR 0223 §4, beside the engine and the store, because they read and change
  their state (device rows, subscriptions, command lanes). Until the inversion that pump runs on
  the JS thread; afterwards on the core thread. Liveness (pings, close grace, idle timeouts) is
  answered by the I/O tasks and does not wait for the pump, with one guard: if the pump has not
  turned for the heartbeat window, pings stop being answered, so a wedged daemon still looks
  wedged to its clients, as it does today (behaviour.md §4).
- **Crates**, all permissive and on crates.io, checked against `native/daemon/deny.toml`:

| Need                 | Crate                                                                                    | Why, and what was rejected                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP server          | `hyper` 1, `hyper-util`, `http-body-util`                                                | The same server ADR 0225 M2 builds for `/mcp`: the loopback listener serves both (`server-http.ts`'s `mcpFirst`), so there is one hyper server, not two. `axum` (Spade's) was rejected for the daemon: today's request chain is an ordered list of predicates (org gate, MCP, outside clients, transfers, machine calls, web root, attachments, icons, Suits, preview, access) that path routing does not express. |
| TLS                  | `rustls` 0.23, `tokio-rustls` 0.26, `rcgen` for the self-signed identity                 | SNI selection (`sni-listener.ts`) is a `ResolvesServerCert`; the pinned fingerprint (`self-signed-certificate.ts`, `tls-identity.ts`) and the Tailscale certificate (`tailscale-certificate.ts`) load as they do today. `native-tls`/OpenSSL rejected (a second TLS stack per platform).                                                                                                                           |
| WebSocket            | `tokio-tungstenite` 0.30 for framing, **plus RFC 7692 per-message deflate** (question 1) | `tungstenite` refuses RSV1 frames (fact 4), so compressed messages need a crate with RFC 7692 support or a small extension of our own over `flate2` on a framing layer that exposes RSV1. T1's first item settles it with a written spike; `remote-compression.server.process.test.ts` is the proof either way.                                                                                                    |
| Compression          | `flate2` (miniz_oxide backend)                                                           | raw deflate for the relay channel's `deflate-raw` and for per-message deflate                                                                                                                                                                                                                                                                                                                                      |
| Noise                | `snow` with its RustCrypto resolver (`x25519-dalek`, `chacha20poly1305`, `sha2`)         | XX and NK with 25519, ChaChaPoly and SHA-256 are what `@ace/secure-channel` speaks; its vector tests pin interoperability. A hand-written Noise was rejected.                                                                                                                                                                                                                                                      |
| JSON                 | `ace-json` (ADR 0225 safeguard 1)                                                        | everything a client parses is written through it, in the schema's key order; no `serde_json` on wire values                                                                                                                                                                                                                                                                                                        |
| Wire types           | `ace-protocol`, generated from `packages/protocol` (§3)                                  | never hand-written                                                                                                                                                                                                                                                                                                                                                                                                 |
| Errors, cancellation | `thiserror`, `tokio-util` `CancellationToken`                                            | as ADR 0223                                                                                                                                                                                                                                                                                                                                                                                                        |

### 3. One wire schema, from `packages/protocol`

- `packages/protocol`'s Zod stays the only source. `scripts/generate-rust-protocol.ts` already
  generates `ace-protocol` from the JSON Schema of the roots the engine uses (`typify`, committed,
  `check:daemon-native` fails on a diff). T0 adds the transport's roots: the hello and welcome,
  subscribe and unsubscribe, snapshot, events and their parts, pages, `fail`, ping and pong, and
  each server message whose producer is Rust.
- **Inbound, the transport decodes only the envelope**: `type`, and the routing ids (`requestId`,
  `subscriptionId`, the command's thread or workspace for its lane). The message's body goes, as
  received, to its owner. A TypeScript owner validates it with today's Zod decoder
  (`services/socket-message.ts`), so its accept and reject decisions and its words don't change; a
  Rust owner decodes it with its generated type, and its tests pin what it accepts.
- **Outbound**, a TypeScript producer hands the transport a finished string (today's
  `JSON.stringify` or `EventEncodings`' bytes), which the transport frames and sends without
  parsing it; a Rust producer writes through `ace-json`.
- **A route table** (`native/daemon/catalog/routes.json`, generated) names each client message
  type's owner: `rust:<crate>` or `js:<service>`. A check in `check:daemon-native` fails when a
  type in the Zod unions has no owner, so a new message can't fall through.

### 4. Reads go to the wire without crossing into JavaScript

ADR 0222 dropped two read phases. Phase 3 (the sidebar) ran 25% slower than TypeScript: a row
decoded in Rust crossed as JSON that JavaScript parsed again, which cost more than V8 decoding the
row itself; review also found it bypassed `ThreadCache` and journal-only ancestry. Phase 1b
(items) gained about 10% on scroll-back and none on the first open, and three builds each differed
from the TypeScript on malformed data, paging or allocation. The rule that came out of them was
"Rust fetches, TypeScript shapes".

With the transport in Rust, a read the socket asked for can go from SQLite to the socket without
becoming a JavaScript value: the native read assembles the answer, `ace-json` writes the message,
the outbox frames it. That removes the cost that sank phase 3 by construction, because nothing is
parsed twice. It does not remove what sank phase 1b, which was divergence, not speed. So:

1. **The rule is amended, not dropped.** "Rust fetches, TypeScript shapes" still holds for a read
   whose consumer is JavaScript. For a read whose consumer is the wire, Rust fetches and shapes,
   and the shaping is the one implementation: once a wire read is default-on, its TypeScript
   shaper is deleted, and the remaining JavaScript callers of that read (agent-control's
   `thread_read`, machines, tests) take the Rust-shaped bytes through a facade that
   `JSON.parse`s them. Never two shapers for one read, past one release.
2. **Trusted rows are spliced, not reshaped.** Rows this build wrote are trusted (ADR 0125); their
   stored JSON goes into the message as stored (`RawValue`-style splices in `ace-json`). Most bytes
   of a snapshot or page are such rows, and splicing them reproduces the TypeScript output by
   construction, because the TypeScript forwards them unchanged too.
3. **Untrusted rows keep today's lenient decode.** Rows from older builds or the rejected set go
   through the TypeScript lenient decoder as a port while the JavaScript runtime is in the process;
   the decoder is ported last, as one function, with the (a) tests that pin it
   (`stored-history-trust`, `stored-trust-*`, `item-store-trusted-reads`) and its (b) cases moved.
   The idle trust pass that already upgrades rows in bounded batches keeps shrinking that set.
4. **The phase 1b divergences are `ace-json`'s and the port's job**: number spellings, UTF-16
   lengths and clipping, duplicate keys and lone surrogates through `ace-json`'s `JsString`;
   paging and allocation by porting the paging rules exactly, proven by `subscription-*`,
   `agent-control/thread-read-paging` and the page tests.
5. **The sidebar waits for its cache.** The sidebar's wire read starts only once `ThreadCache` and
   journal-only ancestry are fed by the Rust writer (store phase 5), so it reads through them
   instead of around them.
6. **Wire reads run on the reader pool.** A wire read needs no JavaScript, so it runs on ADR
   0222 §3's reader pool, off the core thread, with the pool's rules: live writes flushed before
   dispatch, rows and the head watermark from one snapshot, and the main connection whenever a
   transaction is open. A thread open stops blocking the thread that runs the engine, which is
   ADR 0170's rule made structural.
7. **Proof and gate**: the tests ADR 0222 listed for 1b and 3 (`item-store-trusted-reads`,
   `subscription-*`, `stored-history-trust`, `text-storage`, `payloads`,
   `agent-control/thread-read-paging`, `sidebar-*`, `thread-cache.process`, `thread-columns.process`,
   `revision-triggers.process`), unchanged, with the switch on and off; and before-and-after runs of
   `sqlite-store.ts --split`, `thread-open-bytes.ts` and the sidebar benches showing no read
   slower and no client-visible byte changed.

### 5. The process model during the move

- **Until the inversion, Bun is the program and the Rust core is in process**, as today. The
  transport's I/O runs on the addon's tokio threads; its decisions on the pump on the JS thread.
  Every service not yet in Rust is reached through a bridge, the transport's counterpart of ADR
  0223's `JsSession` and ADR 0225's `JsTool`:
  - `JsSocketService`: per authenticated socket, the TypeScript registry's sessions, called with
    the same `SocketContext` (whose members become binding calls into the Rust socket) and fed one
    ordered queue per socket, so messages reach them in arrival order, as `SocketInput` does today.
  - `JsHttpRoute`: an HTTP route not yet in Rust gets the request's head and a body stream and
    answers through a response handle, in the chain's position it has today.
  - `JsEventSource`: until store phase 5, events are published by the TypeScript store; the bridge
    hands their encodings (already serialised once by `EventEncodings`) to the Rust fan-out.
- **Two alternatives were rejected.** A Rust program running the TypeScript shell as a child: every
  one of the 614 synchronous `atomic` callers would cross a process boundary (ADR 0222 §1's
  reasons), the 198 in-process socket test files could no longer inject their ports, and restart
  would supervise two processes whose order matters. Embedding a JavaScript engine in the Rust
  program (V8 through `deno_core`, QuickJS): JavaScript would still run in the daemon, which the
  owner ruled out, and the daemon's code relies on Bun's APIs.
- **The inversion is one step, at the end.** It happens when the TypeScript side of the daemon has
  shrunk to its composition (`index.ts`) and bridges with nothing behind them. Its preconditions:
  1. no TypeScript calls `Store.atomic` (fact 3), so the core runs on its own thread;
  2. every route in the route table is `rust:`, and no `JsHttpRoute` or `JsEventSource` is
     registered in production;
  3. Claude's session is not in the daemon process (question 3);
  4. recurrence and argument wording have their decision (question 2);
  5. every switch of ADRs 0222 to 0226 is default-on and has been for one release.
- **What the inversion changes**: `ace-daemon-bin`'s `main` does what `index.ts` does today
  (configuration, the home and its locks, the store's open, the service start order of
  `services/service-order.ts`, the server, the endpoint and token files, signals and shutdown),
  ported from it with its tests. The launcher (`@ace/service`'s `daemon-program.ts`) starts
  `ace-daemon` when the release has it, under the service names of ADR 0214, and the Bun entry
  otherwise; `ACE_DAEMON=bun` forces the old entry for one release, as the fallback.
- **Reliability across restarts and reconnects (priority 2)**: nothing a client sees changes at any
  step: the endpoint file, the token, the single-instance lock, `ace serve --json`, exit codes
  (`@ace/service/exit-codes`), close codes (4001, 4008, 4009, 1011 and the rest, behaviour.md §5),
  the resync rule, the daemon outliving the app (ADR 0186) and stop ownership by evidence (process
  identity, not executable name, so the new binary's stop is proven the same way). A home is never
  migrated by a switch: each phase changes no stored bytes, and the cross-mode gate (ADR 0223 §8)
  runs the restart tests with a home booted alternately on each backend.
- **ADR 0170 at every step**: the transport never does history-sized work on the pump: replay is
  bounded (`replayLimit`, 5,000 events), pages are bounded, wire reads run on the reader pool, and
  the open-time passes stay where ADR 0222 and ADR 0223 §5 put them.

### 6. Phases, each shippable alone, each switch off by default

Switches are read once by `packages/provider-kit/src/native-switches.ts` (ADR 0223 E0); set without
the native part, the daemon refuses to start and says so.

| Phase | What moves to Rust                                                                                                                                                                                                                                                                    | Switch                           | Needs                                                      | Proven by                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0    | `ace-transport` and `ace-daemon-bin` skeletons, generated wire roots, the route table and its check, switch parsing; the baseline measurements; no behaviour                                                                                                                          | none                             | ADR 0223 E0                                                | `check:daemon-native`                                                                                                                                                                                                                               |
| T1    | Sockets: listeners (loopback, LAN, Tailscale, SNI), TLS, upgrade admission (path, Origin, 256 sockets, pre-auth budgets), WebSocket framing and deflate, liveness, close grace, outbox, input backpressure, frame packing; every message after framing goes to the TypeScript handler | `ACE_TRANSPORT=native`           | T0                                                         | the socket, admission, close, liveness, compression and TLS files (porting guide T1), then all 198 `fixture()` files with the switch on                                                                                                             |
| T2    | Hello, authentication and device identity: `RemoteAuth`, tickets, pairing codes and links, devices and their scopes, account and machine grants on the socket, org standing checks                                                                                                    | `ACE_TRANSPORT=native,auth`      | T1, `ACE_STORE=native` default-on                          | `auth`, `handed-ticket`, `ticket-allocation`, `devices-access`, `remote-boundaries`, `ownership`, `host-identity` server files and the account-access socket files                                                                                  |
| T3    | Subscriptions and fan-out: `subscription`, sidebar subscription, `WireEncoder`, `EventEncodings`, wire trims and short deltas, command lanes and `socket-reads`' core reads                                                                                                           | `ACE_TRANSPORT=native,fanout`    | T2; full effect after store phase 5 and E5                 | `subscription-*`, `subscription.process`, `sidebar-live.process`, `sidebar-pagination.process`, `sidebar-tabs.process`, `sidebar-read-state`, `wire-trim`, `wire-trims.process`, `wire-encoder`, `frame-packing.process`, `socket-commands-recheck` |
| T4    | Reads to the wire (§4): items pages and windows, snapshots, catch-up, turns and steps, then the sidebar                                                                                                                                                                               | `ACE_STORE_READS=wire[,sidebar]` | T3, store phase 5 (the sidebar also `ThreadCache` in Rust) | §4 item 7                                                                                                                                                                                                                                           |
| T5    | HTTP: `/v1` access API, attachments, icons, the web root, preview proxy, Suits, sign-in pages, CORS; each route as its owner moves                                                                                                                                                    | `ACE_HTTP=native[,<route>]`      | T1, ADR 0225 M2 (one server)                               | `access-cors.server.process`, `preview*`, `attachment-*.process`, `attachments.process`, `icons-http`, `relay-http`, `web-http.process`, `maintenance.server.process`                                                                               |
| T6    | Relay: the host control session, joins, Noise XX and NK, early reads, `relay-socket`, the relay channel's per-message deflate, relay machine host                                                                                                                                     | `ACE_RELAY=native`               | T2                                                         | the 10 `relay*.process` files, `relay-nk/`'s unit files and `@ace/secure-channel`'s vector files against `snow`; `slow-link`, `relay-connect` and `relay-resume` benches no worse                                                                   |
| T7    | The inversion (§5)                                                                                                                                                                                                                                                                    | `ACE_DAEMON=native` (launcher)   | every precondition of §5                                   | the daemon-program tests (`daemon-launch-test-support`, `daemon-crash-test-support` users, `cold-start`, `remote-restart`, `late-setup` server files), the release smoke, `bench:daemon` no worse                                                   |
| T8    | Packaging (§8)                                                                                                                                                                                                                                                                        | release layout                   | T7 default-on for one release                              | `tools/release` smoke and install tests on every platform                                                                                                                                                                                           |

- **T1 alone gains no speed and may lose some**: each inbound message and each JavaScript-produced
  outbound message crosses N-API once. That cost is measured before T1 ships (porting guide); if
  it makes the fan-out bench or head-of-line latency worse, T1 ships together with T3, the phase
  that takes the hot outbound path off JavaScript. What T1 buys regardless is reliability:
  framing, compression and liveness stop sharing the JavaScript thread with commits that take up to
  146 ms (ADR 0222, Measurements).
- **Default on** when its files pass on macOS, Linux and the Windows VM with the switch on and off,
  its cross-mode list passes both ways (T2: device rows and tickets; T3 and T4: none, they store
  nothing; T6: relay host keys), its benches are no worse, and it has run one release opt-in.
  TypeScript is deleted one release after default-on (ADR 0223 question 2's recommendation).

### 7. Ordering against the work in flight

The owner's order stands: store, engine and adapters, agent-control, machines, then git, forge,
devices, screens, automations and MCP. The transport fits around it:

1. **Now, beside E1 to E4 and the store's phases**: T0, then T1. T1 needs nothing but E0; it is
   built in parallel with E2 (supervisor) and E3 (sessions) and does not touch their files.
   Coordinate with ADR 0225 M2: whichever lands first owns the hyper server, the other adds to it.
2. **After store phase 5 (the Rust writer) makes `ACE_STORE=native` default-on**: T2, then T3.
   ADR 0222 records that phase 1a alone makes writes 16% slower and ships only with a phase that
   removes the per-statement crossings; T2 and T3 read the device and event tables through the
   native connection, so they wait for it too. They can be built earlier behind their switches.
3. **After T3 and store phase 5**: T4 (items first; the sidebar once `ThreadCache` is fed by the
   Rust writer). E5 (the engine) is not required: events reach the Rust fan-out through the store's
   publication either way.
4. **After T2**: T6, built with the machines ADR, which owns the machine link that shares the
   relay crate.
5. **T5 route by route**, each with its owner: the access API with T2, attachments with the store,
   icons and previews with their owners, `/mcp` with M2.
6. **The rest of the daemon** (the "Left" table) needs ADRs of its own, in this order after
   agent-control and machines: providers and accounts; projects and files; daemon lifecycle (the
   composition is T7's); account and org access; the Spade host side, Store, Suits and plugins;
   browser; outside MCP clients; the engine's and git's remaining callers move with the services
   that call them. Each follows the same rules: behind its TypeScript interface, its (a) tests
   unchanged, switch off by default.
7. **T7 last**, when §5's preconditions hold; **T8** one release after T7 is default-on.

### 8. Packaging

- **Today**: a release holds `bin/node` (Bun 1.4.4 under Node's file name; `bin\node.exe` on
  Windows; ADR 0214 adds the daemon's service name), `ace.mjs` and its assets, the addon, and the
  native helpers (`ace-history`, ace-media, screen helpers, locked use, Spade). The desktop app
  carries the same layout in its `Resources`. ADR 0221 puts the Rust `ace` binary in front, handing
  over to `bin/node ace.mjs` for commands not yet ported.
- **After T7**: the release adds `bin/ace-daemon`; the launcher prefers it. `ace start`, `ace serve`
  and `ace daemon start` (which ADR 0221 always hands over) start `ace-daemon` directly instead.
  `ace.mjs` stays for one release as the fallback and for launchers and updaters from earlier
  releases, which run `<release>/bin/node ace.mjs`: in that release `ace.mjs`'s first act is to
  execute `ace-daemon` with the same arguments, so an old updater starts the new daemon.
- **After T8**: Bun moves from `bin/node` to `runtime/bun` (or keeps its service name), used only
  to start the children in the Context table, with each child's code bundled on its own
  (`cursor-host.mjs`, `pi-workers.mjs`, `bot-kit.mjs`, serve-sim's package) rather than inside the
  daemon bundle. A release with no Cursor, Pi or bot kit use never starts it. Whether Bun is
  downloaded on first need instead of shipped is question 4.
- **Per platform**: macOS and Linux as above; on Windows `ace-daemon.exe` is signed with the other
  binaries and runs as the service ADR 0214 names; the desktop app's daemon spawn
  (`apps/desktop/src/main/daemon/spawn.ts`) goes through `@ace/service`'s launcher, so it changes
  with it. Linux builds keep the glibc floor `tools/release/src/glibc-check.ts` enforces.
- **What shrinks**: the daemon bundle loses each ported module; at T8 it is gone, with its
  `node_modules` (including `ws`, `zod` in the daemon, `@modelcontextprotocol/*`, `koffi`) except
  what the children bundle.

## Consequences

- The daemon becomes one Rust program with one connection owner, one executor, one supervisor and
  one transport; JavaScript runs only in children whose libraries require it.
- Until T7, the move adds N-API crossings at every bridge; each phase measures its own and ships
  only when it is no slower, or together with the phase that removes them.
- The wire contract (`packages/protocol`) stays TypeScript-first, so clients are unaffected; the
  Rust side can only produce what the generated types allow.
- Two hosts exist over one core for good: the program, and the addon the tests load. A behaviour
  that differs between them is a bug in the host, and only the program's own wiring is proven by
  program-level tests; the porting guide lists them.
- The tests stay TypeScript and keep driving the daemon over its socket. They don't double: no
  parity harness and no second suite; (b) cases move into `#[cfg(test)]` beside the Rust code that
  replaces their modules.
- About 144k lines of daemon TypeScript still need ADRs of their own (§7 item 6); this ADR orders
  them but doesn't design them.

## Questions for the owner

1. **Per-message deflate on the direct remote listener.** `tungstenite` can't carry it (fact 4).
   Choose in T1's spike between a WebSocket crate with RFC 7692 support (licence and maintenance
   checked), our own RFC 7692 extension over a framing layer that exposes RSV1, or moving the
   direct listener to the relay channel's application-level `deflate-raw`, which clients already
   speak on relays but would need to request on direct sockets (a client change, out of this
   ADR's scope). Recommended: the first that passes `remote-compression.server.process`
   unchanged, with the client change only as a last resort.
2. **The two TypeScript pieces ADR 0225 kept** block the inversion: recurrence over ICU and Zod's
   wording of rejected tool arguments. Port recurrence with ICU4X's zone data (and serve `ui-core`
   the same code as WebAssembly), and generate argument decoders and their words per schema? Or
   keep a small JavaScript child for them, at a process round trip per call?
3. **Claude's session** is the only provider code still inside the daemon process. Before T7,
   either the Rust stream-json session (ADR 0223's deferred work) lands, or the Agent SDK moves to a
   host child per account, as Cursor's did. Recommended: schedule the Rust session before T7; the
   host child only if it slips.
4. **Bun on disk.** After T8, ship Bun in every release (88.7 MB uncompressed for Bun 1.4.4 on macOS arm64), or download it
   on first need for Cursor, Pi or the bot kit, verified against a pinned checksum?
5. **The test host.** Accept that the TypeScript tests keep loading the Rust core through the addon
   after T7, with program-level proof limited to the listed program tests and the release smoke?
6. **Phase gates.** T1 ships only if no slower, else with T3; T2 to T4 wait for store phase 5's
   default-on; Windows VM runs gate every phase. Accept?
