# 0226: The daemon leaves Bun

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: the owner decided the goal
on 2026-11-23 ("lets move completely from bun backend/server", "start moving sql read write,
transport from daemon to be in rust") and delegated the six design questions ("do whatever is
best"; answers at the end); the design is pending the owner's review.
Revised 2026-11-23 after review: the writer gate for T2 to T4 (§6, §7), one owner for the long-thread
reads (§4), the subscription handoff (§4, behaviour.md §9), ticket and pairing rules (behaviour.md §6),
one owner per listener, encoder and read with wire fixtures (§2, §3), the legacy-row decoder ported
before wire reads (§4), executable inversion gates and a fallback that stays Bun (§5, §8), and the
inventory's startup group (Context).
Revised again the same day after the second review: boot-time resolution of dependent switches and
a writer rollback with T3 on (§6), complete replay coverage or a snapshot (§4), T7's opt-in launch
and its own switch left out of its prerequisites, old launchers' entry points kept through T8
(§5, §8), the NK ticket rule narrowed (behaviour.md §6). T0 and T1 are cut into builder tasks
(porting guide): T1 is split into T1a (the loopback listener) and T1b (the remote TLS
listeners), and the outbox, input backpressure, frame packing and pings stay TypeScript above the
`MainSocket` seam until T3.
Third review (2026-11-23): the T0 and T1 briefs gained the hop-header, guard and caller-ownership
rules, ws's handshake order, an event ABI with send completion and backpressure, capacity
reservation across the async handshake, the shutdown order, paired off/on ship tolerances, and a
generated list of server-starting tests (fact 2's counts corrected).

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
| ADR 0225, devices, screens, locked use (daemon side)                | 18      | 2,178  |
| ADR 0225, the MCP server's daemon side (`tool-result-mcp`, `mcp*`)  | 7       | 1,275  |
| **Covered**                                                         | **480** | 62,747 |

**Left in TypeScript after all five: 982 production modules, 143,980 lines**, grouped below and
listed file by file in [the behaviour guide's inventory](../transport/behaviour.md#11-inventory).

| Left, by responsibility                                                                                                                                                                                                                                                                            | Modules | Lines  | Has an ADR?                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ---------------------------------------------------------------- |
| Machines: `machines/`, `machine-tunnel/`, `machine-update/`, `transfers/`, `parcels/`, `media-relay/`, `files-relay`, `remote-*` jobs                                                                                                                                                              | 144     | 27,389 | no (next in the owner's order, ADR 0222 "Path after the store")  |
| Spade host side, Store (marketplace), Suits, plugins, skills, icons, previews                                                                                                                                                                                                                      | 115     | 16,766 | no                                                               |
| **Transport**: listeners, sockets, HTTP, relay, pairing, auth, device identity, fan-out (T1 to T6)                                                                                                                                                                                                 | 73      | 10,948 | **this ADR**                                                     |
| **Startup, composition and home identity**: `services/startup*`, `composition`, `service-order` and the service slots, `server-options`, `local-files` (data-dir permissions, the instance lock, the daemon token, persistent keys, host id), `local-token`, `machine-paths`, `computer-name` (T7) | 18      | 2,452  | **this ADR**, T7                                                 |
| Git and forge callers: `workspace-*`, `pr-*`, `hosted-*`, `forge-*`, `workspace-runtime`                                                                                                                                                                                                           | 80      | 12,393 | ADR 0224 moves the packages; their 57 daemon callers stay TS     |
| Agent-control (`agent-control/`), knowledge, handoff, measurement, html and image publication                                                                                                                                                                                                      | 83      | 12,100 | no (next after the engine)                                       |
| Daemon lifecycle: `index.ts` composition, shutdown, settings, notifications, storage service and workers, verify, terminal service, app updates                                                                                                                                                    | 100     | 12,044 | no                                                               |
| Store reads: items, sidebar, thread rows and cache, history index, search shaping, status store, entity windows, previews                                                                                                                                                                          | 79      | 11,200 | ADR 0222 dropped them (1b, 3); this ADR's T4 takes the wire path |
| Providers and accounts: account management, logins, provider status, usage, catalogs, installs                                                                                                                                                                                                     | 81      | 10,911 | no (ADR 0223 moves the adapters, not account management)         |
| Projects and files: `projects`, `project-*`, `files-*`, `files-tool/`, linked files, host open                                                                                                                                                                                                     | 48      | 7,951  | no                                                               |
| Engine callers: thread creation, commands, asks, models, run checkpoints, loop monitor, liveness                                                                                                                                                                                                   | 54      | 6,632  | no (callers of `Engine`)                                         |
| Account and org access: `account-access/`, `org-access/`, `org-host/`, `org-registry/`                                                                                                                                                                                                             | 39      | 5,075  | no                                                               |
| Outside MCP clients (`external-mcp/`, ADR 0122)                                                                                                                                                                                                                                                    | 37      | 4,390  | ADR 0225 keeps it TS until its own move                          |
| Browser glue (`browser-*`, `browsing`, `user-browser`)                                                                                                                                                                                                                                             | 21      | 2,332  | no                                                               |
| Small remainders (devices settings, doctor runs, utility, action errors, automation tools)                                                                                                                                                                                                         | 10      | 1,397  | partly 0225                                                      |

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
ICU and Zod's wording of rejected tool arguments, block the inversion; they are ported to Rust
(answer 2).

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
2. **The black-box tests start the server in process.** 198 test files import
   `socket-test-support.ts`; 108 of them build the server with its `fixture()`, which calls
   `startServer` in the test's own process with a TypeScript `Store` and a stub handler, and drive
   it over a real WebSocket. 80 of those pass options, injecting TypeScript ports into
   `ServerOptions` (provider statuses, relay, clock, models, commands, notifications, locked use,
   screen and others), and 72 seed or read the `Store` directly. Other files start servers through
   `startServer` directly (26 files), `remote-test-support.ts`, the engine and agent-control
   harnesses, or `startDaemon` (the whole composition in process, as `daemon-lifecycle.process`
   does). 89 files are `*.server.process.test.ts`. Three test files start the daemon as a separate
   program through `daemon-launch-test-support.ts` or `daemon-crash-test-support.ts`.
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
6. **Tickets live in memory, pairing links in the database.** `RemoteAuth` keeps tickets in a
   `TicketPool` (`remote-auth.ts`, `clearPending`), so a restart voids every outstanding ticket;
   pairing links are stored by hash so a restart doesn't void one being scanned
   (`pairing-codes.ts:80`–`:84`). A direct hello spends its ticket before checking the device it
   names (`socket-hello.ts:27`–`:40`); an NK first message checks the relay key epoch and the device
   before spending, in one synchronous step (`remote-auth.ts:224`–`:232`).
7. **A resuming subscription registers before it reads** (`subscription.ts:208`–`:221`): events
   committed while the snapshot or replay is read are queued and drained above the cursor, and
   cursors stay contiguous through events the subscription filters out (progress frames,
   `:172`–`:177`). The client refuses a batch whose `afterSeq` isn't its own sequence as a gap
   (`packages/client/src/thread-store.ts:378`).
8. **Clients are not part of this.** Every byte a client parses, every close code, every HTTP
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
- Bun ships only for the children in the table above, in every release while any supported
  feature needs one (answer 4), and is started only when a child is needed.

### 2. The transport: where it runs and which crates

- **`ace-transport`**, a crate in `native/daemon`, owns listeners, TLS, HTTP, the WebSocket layer,
  connection admission and liveness, the outbox, hello and authentication, subscriptions and
  fan-out, the relay host link and Noise, and the routing of every inbound message to its owner.
- **I/O on the core's tokio runtime** (ADR 0223 §4: tokio, two workers): accept, TLS, framing,
  compression, reading and writing. **Protocol decisions on the core's executor**, the single-
  threaded pump of ADR 0223 §4, beside the engine and the store, because they read and change
  their state (device rows, subscriptions, command lanes). Until the inversion that pump runs on
  the JS thread; afterwards on the core thread. From T3, liveness (pings, close grace, idle
  timeouts) is answered by the I/O tasks and does not wait for the pump, with one guard: if the
  pump has not turned for the heartbeat window, pings stop being answered, so a wedged daemon still
  looks wedged to its clients, as it does today (behaviour.md §4). In T1 pings, the idle sweep, the
  outbox, input backpressure and frame packing stay TypeScript, above the `MainSocket` seam
  (`main-socket.ts`) that relayed channels already implement; T1's Rust socket implements that
  interface and nothing above it.
- **Crates**, all permissive and on crates.io, checked against `native/daemon/deny.toml`:

| Need                 | Crate                                                                                                                                               | Why, and what was rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP server          | `hyper` 1, `hyper-util`, `http-body-util`                                                                                                           | The same server ADR 0225 M2 builds for `/mcp`: the loopback listener serves both (`server-http.ts`'s `mcpFirst`), so there is one hyper server, not two. `axum` (Spade's) was rejected for the daemon: today's request chain is an ordered list of predicates (org gate, MCP, outside clients, transfers, machine calls, web root, attachments, icons, Suits, preview, access) that path routing does not express.                                                                                                                                                             |
| TLS                  | `rustls` 0.23 on aws-lc-rs with `prefer-post-quantum`, installed as the process provider; `tokio-rustls` 0.26; `rcgen` for the self-signed identity | SNI selection (`sni-listener.ts`) is a `ResolvesServerCert`; the pinned fingerprint (`self-signed-certificate.ts`, `tls-identity.ts`) and the Tailscale certificate (`tailscale-certificate.ts`) load as they do today. aws-lc-rs, not ring (changed 2026-11-24, porting guide T1b): `X25519MLKEM768` is negotiated today between Node 26 and Bun, Chromium 131+ and iOS 26 offer it by default, and ring has no ML-KEM, so a ring-only listener would downgrade those connections to classical key exchange. `native-tls`/OpenSSL rejected (a second TLS stack per platform). |
| WebSocket            | `tokio-tungstenite` 0.30 for framing, **plus RFC 7692 per-message deflate** (answer 1)                                                              | `tungstenite` refuses RSV1 frames (fact 4), so compressed messages need a crate with RFC 7692 support or a small extension of our own over `flate2` on a framing layer that exposes RSV1. T1's first item settles it with a written spike; `remote-compression.server.process.test.ts` is the proof either way.                                                                                                                                                                                                                                                                |
| Compression          | `flate2` (zlib-rs backend)                                                                                                                          | raw deflate for the relay channel's `deflate-raw` and for per-message deflate. zlib-rs, not miniz_oxide (changed 2026-11-24, porting guide T1b): `ws` deflates with a client's `server_max_window_bits`, which needs flate2's window-bits constructors, available only with a zlib backend; zlib-rs is Rust and Zlib-licensed                                                                                                                                                                                                                                                  |
| Noise                | `snow` with its RustCrypto resolver (`x25519-dalek`, `chacha20poly1305`, `sha2`)                                                                    | XX and NK with 25519, ChaChaPoly and SHA-256 are what `@ace/secure-channel` speaks; its vector tests pin interoperability. A hand-written Noise was rejected.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| JSON                 | `ace-json` (ADR 0225 safeguard 1)                                                                                                                   | everything a client parses is written through it, in the schema's key order; no `serde_json` on wire values                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Wire types           | `ace-protocol`, generated from `packages/protocol` (§3)                                                                                             | never hand-written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Errors, cancellation | `thiserror`, `tokio-util` `CancellationToken`                                                                                                       | as ADR 0223                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

- **One owner per listener, decided at boot.** Switches are read once per process, so a port is
  never bound by two implementations and a rollback is a restart with the switch off. ADR 0225 M2
  gives the MCP server its own listener and keeps the `serve`/`handleHttp` hooks for the daemon's
  `/mcp` path; this table adds the transport:

| `ACE_TRANSPORT` | `ACE_MCP` | Daemon listeners (loopback, LAN, Tailscale) | `/mcp` on the daemon's loopback listener                          | MCP's own listener |
| --------------- | --------- | ------------------------------------------- | ----------------------------------------------------------------- | ------------------ |
| off             | off       | TypeScript (`node:http`, `ws`)              | TypeScript MCP server                                             | TypeScript         |
| off             | native    | TypeScript                                  | the Rust MCP handler through `options.mcp.handleHttp` (M2's hook) | Rust (M2)          |
| native          | off       | Rust (`ace-transport`)                      | the TypeScript MCP server as a `JsHttpRoute`                      | TypeScript         |
| native          | native    | Rust                                        | routed in Rust, no crossing                                       | Rust               |

Whichever of T1 and M2 lands first builds the hyper server crate; the second reuses it. Turning
either switch off moves only its row's ownership back at the next start; nothing is persisted
about which side served.

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
- **One encoder and one shaper per read, per process.** At boot the process picks, from its
  switches, either the TypeScript `EventEncodings`/`WireEncoder` or the Rust encoder for every
  socket, and for each read either its TypeScript or its Rust shaper; never both at once in one
  process, so two sockets never see two encodings of one event.
- **Zod stays authoritative, and generated types don't prove parity.** A generated Rust type can
  accept what Zod rejects (refinements, transforms, defaults, unknown-key stripping) and can
  serialise in another order. So every owner swap, inbound or outbound, is gated by a check over
  fixtures made from samples the repository already has (the protocol tests' messages,
  `canonical-event` samples, the recorded provider sessions under `fixtures/` replayed through
  translators, core and projection as `wire-trims.ts` does, and the slow-link fixtures):
  `check:wire-fixtures` decodes each inbound sample with Zod and with the Rust owner and requires the
  same accept or reject (and, accepted, the same value), and encodes each outbound sample with both
  encoders and requires identical bytes. It is a check in `check:daemon-native`, like ADR 0225's
  catalog checks, over existing data: not a test suite, and no case is written for it. A mismatch
  is a bug in the Rust side; Zod's answer stands.

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
   and the shaping is the one implementation. When a wire read goes default-on, the remaining
   JavaScript callers of that read (agent-control's `thread_read`, machines, tests) switch in the
   same release to a facade that `JSON.parse`s the Rust-shaped bytes; the TypeScript shaper stays
   only as the switch-off path and is deleted one release later, with the switch. Within one
   process only one shaper runs (§3).
2. **Trusted rows are spliced, not reshaped.** Rows this build wrote are trusted (ADR 0125); their
   stored JSON goes into the message as stored (`RawValue`-style splices in `ace-json`). Most bytes
   of a snapshot or page are such rows, and splicing them reproduces the TypeScript output by
   construction, because the TypeScript forwards them unchanged too.
3. **The lenient decoder for untrusted rows is ported first.** Rows from older builds or the
   rejected set go through today's lenient decode. A JavaScript port for it would put a JS call
   inside a reader-pool read, which item 8 rules out, so T4 begins with T4a: the decoder ported to
   Rust as one function, with the (a) tests that pin it (`stored-history-trust`, `stored-trust-*`,
   `item-store-trusted-reads`) unchanged, its (b) cases moved, and the wire fixtures of §3 run over
   legacy rows from the trust tests' samples. No wire read is enabled before T4a is default-on.
   The idle trust pass keeps shrinking that set meanwhile.
4. **The phase 1b divergences are `ace-json`'s and the port's job**: number spellings, UTF-16
   lengths and clipping, duplicate keys and lone surrogates through `ace-json`'s `JsString`;
   paging and allocation by porting the paging rules exactly, proven by `subscription-*`,
   `agent-control/thread-read-paging` and the page tests.
5. **The handoff between the read and live events** (behaviour.md §9, fact 7): the wire read
   registers for live events before it reads; takes its rows and its head watermark from one
   snapshot; buffers the commits published in between; then delivers strictly above the watermark,
   in order. Cursors stay contiguous through filtered events, including progress-only frames, so a
   reconnect can neither miss a committed status change (priority 1) nor make the client see a gap
   and resync. **A bounded read never advances past what it delivered**: today `readEvents`
   includes the event that crosses its byte budget (`store.ts:1182`), so the caller sees the
   overflow and sends a snapshot (`subscription.ts:283`–`:318`). A Rust read must likewise either
   cover every event through the watermark it reports, or report overflow so a snapshot is sent;
   returning a prefix with the cursor moved to the watermark would skip events the client then
   accepts as complete (`thread-store.ts:374`–`:378` checks only `afterSeq`), losing a status
   change. A reader-pool read that is cancelled (the socket closed, the subscription stopped)
   drops its snapshot at once and delivers nothing; a snapshot is never held past its one read.
6. **The long-thread reads have one owner: store phase 2.** `turnsPage`, `turnSteps` and
   `threadCatchUp` are ADR 0222 phase 2's (`ACE_STORE_READS=long`). T4 does not build them; once T3
   is on, phase 2's owner adds their wire encoding under the same switch and the rules of this
   section.
7. **The sidebar waits for its cache.** The sidebar's wire read starts only once `ThreadCache` and
   journal-only ancestry are fed by the Rust writer (store phase 5), so it reads through them
   instead of around them.
8. **Wire reads run on the reader pool.** A wire read needs no JavaScript, so it runs on ADR
   0222 §3's reader pool, off the core thread, with the pool's rules: live writes flushed before
   dispatch, rows and the head watermark from one snapshot, and the main connection whenever a
   transaction is open. A thread open stops blocking the thread that runs the engine, which is
   ADR 0170's rule made structural.
9. **Proof and gate**: the tests ADR 0222 listed for 1b and 3 (`item-store-trusted-reads`,
   `subscription-*`, `stored-history-trust`, `text-storage`, `payloads`,
   `agent-control/thread-read-paging`, `sidebar-*`, `thread-cache.process`, `thread-columns.process`,
   `revision-triggers.process`), unchanged, with the switch on and off; and before-and-after runs of
   `sqlite-store.ts --split`, `thread-open-bytes.ts` and the sidebar benches showing no read
   slower, and `check:wire-fixtures` showing no client-visible byte changed.

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
  - No event bridge: T3 starts only once store phase 5's writer is default-on (§6), so every event
    the Rust fan-out sends is published by `ace-store`, whichever engine (TypeScript or E5's) wrote
    it.
- **Two alternatives were rejected.** A Rust program running the TypeScript shell as a child: every
  one of the 614 synchronous `atomic` callers would cross a process boundary (ADR 0222 §1's
  reasons), the in-process server tests (fact 2) could no longer inject their ports, and restart
  would supervise two processes whose order matters. Embedding a JavaScript engine in the Rust
  program (V8 through `deno_core`, QuickJS): JavaScript would still run in the daemon, which the
  owner ruled out, and the daemon's code relies on Bun's APIs.
- **The inversion is one step, at the end.** It happens when the TypeScript side of the daemon has
  shrunk to its composition (`index.ts`) and bridges with nothing behind them. Its gates are
  executable, in `scripts/check-inversion.ts`, run by `check:daemon-native` once T7 starts and
  required to pass before `ACE_DAEMON=native` can default on:
  1. **zero production `Store.atomic`, `write` or `maintenance` callers**: no module in the daemon bundle's production graph (taken from the bundle's metafile, not a
     grep of the tree) calls them, checked by parsing those modules;
  2. **zero production JavaScript bridges**: every route-table entry is `rust:`, and a started
     daemon with production options reports no registered `JsSocketService`, `JsHttpRoute`,
     `JsSession` or `JsTool` (a diagnostics counter the check reads);
  3. **Claude out of process**: the daemon bundle's metafile contains no
     `@anthropic-ai/claude-agent-sdk` module, and the Claude adapter's session (a) files pass with
     the Rust session (answer 3);
  4. recurrence and argument wording run in Rust (answer 2): no module of `@ace/automations/recurrence`
     or Zod's issue formatting is in the bundle's production graph;
  5. every switch of ADRs 0222 to 0226 **except `ACE_DAEMON` itself** is default-on and has been
     for one release.
- **What the inversion changes**: `ace-daemon-bin`'s `main` does what `index.ts` does today
  (configuration, the home and its locks, the store's open, the service start order of
  `services/service-order.ts`, the server, the endpoint and token files, signals and shutdown),
  ported from it with its tests.
- **How a release launches during T7** (`@ace/service`'s `daemon-program.ts`, and the installed
  launchers of `launcher.ts`, which run `<release>/bin/node <release>/ace.mjs`, `:6` and `:34`):
  - **Opt-in releases** (T7 built, not default-on): the Bun daemon is the default. `ace-daemon`
    ships beside it and runs only when `ACE_DAEMON=native` is set (environment, or the setting the
    launcher reads); `ace.mjs` is the Bun daemon itself, as today.
  - **The default-on release**: `ace-daemon` is the default; `ACE_DAEMON=bun` forces the Bun
    daemon, as the fallback, for that release. The fallback starts a separately addressable entry
    (§8), never the forwarding shim, so it can't land back in Rust.
  - The flip from the first to the second is T7's own default-on; it is gated by §8's three runs,
    not by itself.
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

| Phase | What moves to Rust                                                                                                                                                                                                                                                                                                       | Switch                                              | Needs                                                       | Proven by                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0    | Switch parsing with boot-time dependency resolution, the `ace-transport` crate skeleton, the route table and its check; the baseline measurements; no behaviour (wire roots and `check:wire-fixtures` come with the first Rust producer, T2; `ace-daemon-bin` with T7)                                                   | none                                                | ADR 0223 E0                                                 | `check:daemon-native`                                                                                                                                                                                                                               |
| T1    | T1a: the loopback listener in Rust: HTTP/1.1 accept, WebSocket upgrade and framing, a Rust socket behind `MainSocket`; HTTP requests proxied to the unchanged TypeScript chain; upgrade admission decided by today's TypeScript. T1b: the LAN and Tailscale TLS listeners, SNI and per-message deflate (after its spike) | `ACE_TRANSPORT=native` (T1a), `native,remote` (T1b) | T0                                                          | the socket, admission, close, liveness, compression and TLS files (porting guide T1), then every server-starting test file (porting guide T1a.8's list), switch off and on                                                                          |
| T2    | Hello, authentication and device identity: `RemoteAuth`, tickets, pairing codes and links, devices and their scopes, account and machine grants on the socket, org standing checks (behaviour.md §6's rules)                                                                                                             | `ACE_TRANSPORT=native,auth`                         | T1, store phase 5's **writer** default-on                   | `auth`, `handed-ticket`, `ticket-allocation`, `devices-access`, `remote-boundaries`, `ownership`, `host-identity` server files and the account-access socket files                                                                                  |
| T3    | Subscriptions and fan-out: `subscription`, sidebar subscription, `WireEncoder`, `EventEncodings`, wire trims and short deltas, command lanes and `socket-reads`' core reads; events from `ace-store`'s publication                                                                                                       | `ACE_TRANSPORT=native,fanout`                       | T2 (so the writer is on); E5 not needed                     | `subscription-*`, `subscription.process`, `sidebar-live.process`, `sidebar-pagination.process`, `sidebar-tabs.process`, `sidebar-read-state`, `wire-trim`, `wire-trims.process`, `wire-encoder`, `frame-packing.process`, `socket-commands-recheck` |
| T4    | T4a the lenient legacy-row decoder, then reads to the wire (§4): items pages and windows, snapshots, then the sidebar (turns, steps and catch-up are store phase 2's, §4 item 6)                                                                                                                                         | `ACE_STORE_READS=wire[,sidebar]`                    | T3, T4a default-on (the sidebar also `ThreadCache` in Rust) | §4 item 7                                                                                                                                                                                                                                           |
| T5    | HTTP: `/v1` access API, attachments, icons, the web root, preview proxy, Suits, sign-in pages, CORS; each route as its owner moves                                                                                                                                                                                       | `ACE_HTTP=native[,<route>]`                         | T1, ADR 0225 M2 (one server)                                | `access-cors.server.process`, `preview*`, `attachment-*.process`, `attachments.process`, `icons-http`, `relay-http`, `web-http.process`, `maintenance.server.process`                                                                               |
| T6    | Relay: the host control session, joins, Noise XX and NK, early reads, `relay-socket`, the relay channel's per-message deflate, relay machine host                                                                                                                                                                        | `ACE_RELAY=native`                                  | T2                                                          | the 10 `relay*.process` files, `relay-nk/`'s unit files and `@ace/secure-channel`'s vector files against `snow`; `slow-link`, `relay-connect` and `relay-resume` benches no worse                                                                   |
| T7    | The inversion (§5)                                                                                                                                                                                                                                                                                                       | `ACE_DAEMON=native` (launcher)                      | `check-inversion` passes (§5)                               | the daemon-program tests (`daemon-launch-test-support`, `daemon-crash-test-support` users, `cold-start`, `remote-restart`, `late-setup` server files), the release smoke, the three rollback runs of §8, `bench:daemon` no worse                    |
| T8    | Packaging (§8)                                                                                                                                                                                                                                                                                                           | release layout                                      | T7 default-on for one release                               | `tools/release` smoke and install tests on every platform                                                                                                                                                                                           |

- **T1 alone gains no speed and may lose some**: each inbound message and each JavaScript-produced
  outbound message crosses N-API once. That cost is measured before T1 ships (porting guide); if
  it makes the fan-out bench or head-of-line latency worse, T1 ships together with T3, the phase
  that takes the hot outbound path off JavaScript. What T1 buys regardless is that accepting,
  HTTP parsing, WebSocket framing (and, with T1b, TLS and compression) stop running on the
  JavaScript thread, which commits take for up to 146 ms (ADR 0222, Measurements); liveness moves
  off it with T3.
- **The writer gate.** `ACE_STORE=native` names only the native connection (phase 1a); ADR 0222
  gives the phase 5 writer a switch of its own, whose name it leaves to that phase (called
  `ACE_STORE_WRITER` here). T2, T3 and T4 need the writer itself default-on, not the connection, so
  the transport's cutover can't start while TypeScript still owns the transaction stack.
- **Dependent switches resolve together at boot.** `native-switches.ts` resolves every switch once,
  before anything binds or opens: each phase's needs (this table, ADR 0222 and ADR 0225 §6) are
  checked in dependency order. A phase that is on only by default whose need is off falls back to
  TypeScript together with everything that needs it, and the boot log names each phase that fell
  back and why; a phase set on explicitly whose need is off makes the daemon refuse to start, before
  binding a port or opening the database, naming both switches. So turning the writer off
  (`ACE_STORE_WRITER=typescript`) while T3 is default-on starts the daemon with T2, T3 and T4 on
  TypeScript too, never with native fan-out lacking its event source; T1 doesn't need the writer and
  stays as it is. The cross-mode list gains a writer rollback run with T3 already default-on: a home
  booted with the writer and T3 on, restarted with the writer off, then on again, with a paired
  device reconnecting and a working thread's events and status arriving complete at each step.
- **Default on** when its files pass on macOS, Linux and the Windows VM with the switch on and off,
  its cross-mode list passes both ways, its benches and `check:wire-fixtures` pass, and it has run
  one release opt-in. Cross-mode lists: T2's prove that a restart on the other backend keeps
  persisted pairings, devices and their generations, voids every outstanding ticket (they live in
  memory, fact 6), and lets a paired device mint a fresh one (`auth.server`, `handed-ticket.server`,
  `ticket-allocation.server`, `remote-restart.server`); T3 and T4 store nothing; T6 keeps the relay
  host keys and the NK epoch.
  TypeScript is deleted one release after default-on (ADR 0223 question 2's recommendation).

### 7. Ordering against the work in flight

The owner's order stands: store, engine and adapters, agent-control, machines, then git, forge,
devices, screens, automations and MCP. The transport fits around it:

1. **Now, beside E1 to E4 and the store's phases**: T0, then T1. T1 needs nothing but E0; it is
   built in parallel with E2 (supervisor) and E3 (sessions) and does not touch their files.
   Coordinate with ADR 0225 M2: whichever lands first owns the hyper server, the other adds to it.
2. **After store phase 5's writer is default-on** (§6, the writer gate): T2, then T3. ADR 0222
   records that phase 1a alone makes writes 16% slower and ships only with a phase that removes the
   per-statement crossings; T2 and T3 also need the transaction stack in Rust so device rows and
   events are written and published by one owner. They can be built earlier behind their switches.
   E5 is not required: the TypeScript engine's writes go through the Rust writer too.
3. **After T3**: T4a, then T4 (items first; the sidebar once `ThreadCache` is fed by the Rust
   writer). Store phase 2 adds the long-thread reads' wire encoding once T3 is on.
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
- **During T7**: the release adds `bin/ace-daemon`. In opt-in releases the launcher and `ace.mjs`
  start the Bun daemon unless `ACE_DAEMON=native` (§5); from the default-on release they start
  `ace-daemon`, and `ace start`, `ace serve` and `ace daemon start` (which ADR 0221 always hands
  over) start it directly. For the default-on release (the fallback release) the Bun daemon ships whole and separately addressable:
  `daemon-bun/ace.mjs` with its assets, addon and `node_modules`, started by the launcher only when
  `ACE_DAEMON=bun` is set. `ace.mjs` at the old path stays for launchers and updaters from earlier
  releases, which run `<release>/bin/node ace.mjs`; it is a shim that executes `ace-daemon` with the
  same arguments unless `ACE_DAEMON=bun` is set, in which case it imports `daemon-bun/ace.mjs`.
  T7's default-on is gated by three runs on installed release artifacts, not a development tree:
  an updater from the previous release launching the new release; a forced fallback
  (`ACE_DAEMON=bun`) through both the launcher and the old `ace.mjs` path; and one home started
  native, then Bun, then native, with a paired device reconnecting and a working thread resuming at
  each step.
- **After T8**: Bun is used only to start the children in the Context table, with each child's code
  bundled on its own (`cursor-host.mjs`, `pi-workers.mjs`, `bot-kit.mjs`, serve-sim's package)
  rather than inside the daemon bundle, and `daemon-bun/` is removed. **The entry points older
  installed launchers invoke stay**: `<release>/bin/node` (`bin\node.exe`) and `<release>/ace.mjs`,
  the latter as the forwarding shim, because launchers written by earlier installs run exactly
  those paths (`launcher.ts:6`, `:34`) and are not rewritten by every update. They may be removed
  only in a release whose upgrade gate passes from the oldest supported installed launcher, on
  macOS and on the Windows VM, with installed artifacts; until then Bun keeps the `bin/node` path. A person with no Cursor, Pi or bot kit use never
  starts it. Bun ships in every release while any supported feature needs a JavaScript child
  (answer 4).
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

## The owner's answers (2026-11-23)

The owner delegated the six questions of the first draft ("do whatever is best"); decided on that
basis:

1. **Per-message deflate.** T1's spike picks a maintained server crate with RFC 7692
   permessage-deflate, accepted only after browser, iOS and inflated-size tests pass
   (`remote-compression.server.process` and behaviour.md §2's post-inflate cap). Direct negotiation
   stays unchanged. Our own RFC 7692 extension is the fallback; application-level `deflate-raw` on
   direct sockets only as a last resort.
2. **Recurrence and argument wording are ported to Rust**, recurrence shared with the browser
   through WebAssembly, gated by fixtures for daylight-saving and calendar behaviour and the exact
   rejection text. No JavaScript child for them. This amends ADR 0225 §4.1 and §4.2 for the
   inversion.
3. **Claude**: a Rust stream-json session, built in the provider-sessions work (the owner,
   2026-11-23, ADR 0223), before T7. A supervised SDK host child is the fallback only if that slips,
   gated on recovery and subtree-state parity.
4. **Bun ships in every release** while any supported feature needs a JavaScript child, for
   reliability (priority 2: no first-use download that can fail offline). Revisited with a
   measurement once the JavaScript children are few.
5. **The test host**: after T7 the tests keep loading the Rust core through the addon, so tests
   move, they don't multiply.
6. **Phase gates**: T1 ships only if no slower, otherwise together with T3; T2 to T4 wait for store
   phase 5's writer default-on (§6); a Windows VM run gates every phase.

## The owner's decision (2026-11-26): no new bridges, build the Rust daemon directly

The owner: "as we are going full on rust, now stop writing unnecessary ts bridge", and, asked
about the work in flight, "stop bridges now". The per-piece route of §5 and §6 (Bun stays the
program, every Rust piece is reached through a binding and a TypeScript facade behind its own
switch, and the inversion comes once every switch has been on by default) is replaced for all new
work:

- **No new bridges.** No new `JsSocketService`, `JsHttpRoute`, `JsSession` or `JsTool`, napi
  binding in `ace-daemon-node`, TypeScript facade (`native-*.ts`), per-piece switch wiring, or
  TypeScript seam in a TypeScript module. Bridge code already merged stays as it is, off by default,
  fixed only when broken, and is deleted with the TypeScript it shadows.
- **Rust cores, proven in Rust.** Each item builds its Rust crate (sans-IO logic, a Rust shell) and
  proves it with Rust tests that port the TypeScript cases, which are named in the test file's
  header, as E1's translators and the E3 cores already do.
- **The daemon program is built directly.** `ace-daemon-bin` composes the Rust crates (store,
  transport, engine, sessions, git, devices, MCP) into a program that serves ace's wire. It is
  written as soon as the first end-to-end slice can serve a client, and runs beside the Bun daemon
  only when `ACE_DAEMON=native` is set.
- **Proof at the program.** The TypeScript server and process test files that drive a daemon over
  its endpoint (socket, HTTP and process tests) run against `ace-daemon-bin` as each slice they
  need lands. Together with the ported Rust tests they replace the "both legs" proof. The
  cross-mode gate becomes a home booted alternately by the Bun daemon and `ace-daemon-bin`.
- **The inversion gate changes.** §5's gates 1 to 4 lose their object, since no JavaScript runs in
  `ace-daemon-bin`. Gate 5 (every switch default-on for one release) is replaced by: the TypeScript
  server and process files pass against `ace-daemon-bin` on macOS, Linux and the Windows VM, the
  cross-mode runs pass both ways, `bench:daemon` is no worse, and §8's three rollback runs pass.
  `ACE_DAEMON=native` then defaults on as §5 describes.
- **Still to plan**: the order of slices for `ace-daemon-bin` (which crates it needs to serve a
  first client end to end: configuration, home and locks, the store, the transport's T1 to T3
  pieces, the engine through E5.10, the provider sessions, then HTTP, relay and the tools). It
  goes in `docs/daemon/rust-daemon-plan.md`, briefed before builders start on it.
