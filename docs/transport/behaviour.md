# The transport: observable behaviour and invariants

This is the contract any implementation of the daemon's transport must keep, whichever language
runs it: listeners, TLS, HTTP, the WebSocket protocol, hello and authentication, admission,
liveness, input and output flow, subscriptions and fan-out, and the relay. It describes
`startServer` (`apps/daemon/src/server.ts`) and the modules it wires, as of
`ace/daemon-rust-rewrite` 13e95607e6 (2026-11-23). [ADR 0226](../adr/0226-the-daemon-leaves-bun.md)
decides how it moves; [porting-guide.md](porting-guide.md) is for the builders. §11 inventories
everything in the daemon still TypeScript after ADRs 0221 to 0225; §12 says which tests guard
this contract.

Clients are not part of the move. Every rule below is stated as what a client, a peer or a test
observes, and must hold unchanged with any `ACE_TRANSPORT`, `ACE_HTTP`, `ACE_RELAY` or
`ACE_DAEMON` value.

## 1. What it is and where its work runs

- `startServer(options)` returns the server's URLs, notification hooks, maintenance gate,
  diagnostics queues, remote-start promises and `close()` (`server.ts:88`–`:110`). The daemon's
  composition (`index.ts`) calls it once; 108 test files call it through
  `socket-test-support.ts`'s `fixture()` with a TypeScript `Store` and injected ports, and others
  through `startServer`, the test harnesses or `startDaemon` (ADR 0226, fact 2).
- One protocol implementation serves every route: the daemon's own listeners hand `ws` sockets,
  and the relay hands channels wrapped to the same surface (`main-socket.ts`, `relay-socket.ts`).
- Per authenticated socket, `createSocketRegistry` (`services/registry.ts`) builds 64 service
  sessions (61 factories plus diagnostics, screen and locked use). Each implements `SocketService`
  (`services/socket.ts`): `handle`, `command` (types, scope, accept, refused), `binary`,
  `authenticated`, `welcomed`, `revoked`, `close`, `healthPending`. They see the socket through
  `SocketContext` (authorization, org standing, person proof, send, fail). Registration order is
  contract where noted: the tunnel, browser and files sessions come before the others because the
  files channel claims every binary message (`registry.ts`, comment before `createTunnelSession`).
- Today all of it runs on the JavaScript thread, beside the store's commits (p95 11.6–15.2 ms, max
  146 ms on the owner's home, ADR 0222). Under ADR 0226 the I/O moves to tokio and the decisions to
  the core's pump; nothing in this contract depends on which thread runs it.

## 2. Listeners and upgrade admission

- **Loopback listener** on `127.0.0.1:<port>` (`port: 0` in tests picks a free one), plain HTTP and
  WebSocket. **Remote listeners** when remote access is on: the pinned-TLS LAN listener, the
  Tailscale HTTPS listener with SNI (`sni-listener.ts`, `tailscale-certificate.ts`), each started by
  `remote-runtime.ts` and togglable at run time; and **relay** channels (§10).
- **Under `ACE_TRANSPORT=native,remote`** each run-time listener is Rust's
  (`native-sni-listener.ts`): it terminates TLS and HTTP and forwards to its own internal server
  through the hop, and every upgrade is decided by the same admission TypeScript runs for `ws`.
  `remote-runtime.ts` and `remote-direct.ts` still decide every open, move and close, and Tailscale's
  certificate is pushed to Rust whenever the one TypeScript serves changes.
- Listening never waits for remote access: `remoteStarted.direct` settles once the LAN and
  Tailscale listener started or failed, `networks` once every network did; both settle on close and
  never reject (`server.ts:101`–`:106`).
- **WebSocket upgrades** (`socket-upgrade.ts`): only path `/`; on loopback only an allowed
  Origin (the HTTP access allowlist, `web-origins.ts`) or, when the daemon serves the web app, its
  own literal loopback origin (`127.0.0.1`, `localhost`, `[::1]`; a DNS name rebound to loopback
  is refused, `:11`–`:24`); refused upgrades answer `403 Forbidden`, or `503 Service Unavailable`
  over capacity (`:65`, `:71`); any other path is dropped without an answer (`:52`–`:55`).
- **An upgrade without an Origin is admitted on loopback** (`:58`–`:61`: the check applies only when
  `origin !== undefined`): native clients, the CLI and the desktop app's main process send none.
  Remote listeners don't check Origin at all; their clients authenticate with tickets, and native
  ones send an Origin derived from the URL.
- **Origin and authentication are independent.** The Origin check runs before the hello and
  doesn't look at credentials, so a page from a refused origin is refused even holding a valid
  token; a valid Origin grants nothing, since the hello must still authenticate (§6).
- **Capacity**: at most 256 sockets (`server.ts:289`, `:393`); a socket over it is closed with
  `4013 connection_limit`.
- **Pre-authentication budget** (`socket-admission.ts:19`–`:24`): 128 unauthenticated sockets on
  loopback, 64 on remote listeners, 16 per remote address, and a hello deadline of 5 s, after which
  an unauthenticated socket is terminated. Authenticating releases the slot.
- **Message size**: 1 MiB per inbound message (`maxPayload`, `server.ts:252`, `:256`); larger closes
  with `1009`. On a compressed socket the limit applies **after inflation** (`ws` checks the
  inflated length against `maxPayload`), so a small compressed frame can't expand past 1 MiB in
  memory; a Rust inflater stops and closes with `1009` as soon as the inflated bytes pass the limit.
- **Per-message deflate** only on remote listeners (`remoteDeflate`, `server.ts:257`): RFC 7692
  without context takeover, both directions; outbound compression is chosen per message by the
  allowlist in `compression-policy.ts` (transcript and history bulk only, never a message that may
  carry a credential), for messages of at least 1,024 bytes. Loopback sockets never compress.
- **Recorded difference (T1b.3b, window bits 8)**: an offer of `server_max_window_bits=8` is
  answered `=8`, as `ws` does, but the deflater is built with a 9-bit window: `flate2`'s window
  constructors panic below 9, and zlib-rs 0.6.8 at level 6 keeps every match distance within 250
  bytes, inside the 256 an 8-bit window may rely on (RFC 7692 §7.2.1). No test compares our bytes
  with Node's; the tests decode our output with a decoder that refuses a distance past 256.
  Inflating always uses a 15-bit window, which reads every stream a smaller window can produce.
- **Recorded difference (T1b.3b, extension parameter numbers)**: `ws` reads a window-bits value
  with JavaScript's `+value`, so `0x0a`, `1e1`, `10.0` and `+10` negotiate there and get its `400`
  here; only decimal digits are read. No ace client sends any of them.
- **Recorded difference (T1a.6's socket shell)**: outbound text that isn't valid UTF-8, a JavaScript
  string holding a lone surrogate included, fails that send's callback instead of reaching the
  peer, where `ws` sends the bytes and the peer closes with `1007`. The callback's error reads
  `Invalid WebSocket frame: invalid UTF-8 sequence`. tungstenite cannot build an invalid text
  frame, and the daemon sends JSON strings, so no message the daemon composes is affected.

## 3. HTTP

Two request chains, each an ordered list where the first handler that claims a request answers it
(`server-http.ts`):

- **Loopback**: org gate (`orgHttpGate(false, …)`, ADR 0209 §4.2) → `/mcp` and Spade's machine
  grant path (`mcpFirst`) → web root (`webHttp`, the built web app when present) → attachments →
  icons → Suits (scene and assets by their URL's grant) → preview proxy → access API
  (`access-http.ts`: `/v1/*` with the host bearer, maintenance and stop endpoints).
- **Remote** (paired devices; static and run-time TLS listeners share it): org gate (`true`) →
  outside MCP clients at the ts.net name (ADR 0122) → transfers → machine calls → web root →
  attachments → icons → … → access API with device bearers.
- **Origin on HTTP** (`access-http.ts:61`–`:163`): only the cross-origin routes (account paths,
  `/v1/status`, `/v1/pair`, tickets, paired devices, revoking) answer CORS, and only to an
  allowlisted Origin (`web-origins.ts`); a preflight from any other origin is `403 Origin not
allowed`. A request without an Origin (the CLI, native clients) is not refused for it: it is
  authenticated by its bearer like any other. Every response is `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `Vary: Origin`; the token travels only in `Authorization`, never in
  a URL or cookie.
- CORS, status codes, headers and bodies of each route are contract (guarded by
  `access-cors.server.process` and the route tests in §12). Range requests, upload budgets and
  relay attachments keep their limits (`attachment-range`, `attachment-http-budget`,
  `attachment-relay`, `attachment-upload` process tests).
- **Parity note (T1a.2's proxy hop)**: a client that goes away while its upload is backpressured is
  noticed on the next read or write of its socket, not immediately — exactly what Node's HTTP server
  does when it pauses a socket the same way. The exchange's 300 s deadline bounds the wait.
- **Recorded difference (T1a.2's proxy hop)**: a request-target in absolute form with no path
  (`GET http://host`) reaches the handlers as `http://host/`, because `http::Uri` fills the empty
  path when the hop frames the request and cannot represent it otherwise. Direct browser, iOS and
  CLI requests use origin-form and are untouched, and RFC 9112 §3.2.2 makes an empty path
  equivalent to `/`.
- **Recorded difference (T1a.3's keep-alive upgrades)**: an upgrade that arrives later on a
  keep-alive connection is answered through hyper, which writes response header names in lower
  case (`connection`, `content-type`, `content-length`), where `ws` writes `Connection`,
  `Content-Type` and `Content-Length` on the first-on-a-connection path; HTTP treats field names
  as equal (RFC 9110 §5.1). A `HEAD` upgrade there keeps `ws`'s `405` status and headers, including
  `Content-Length: 19`, but carries no body, because hyper forces a response to `HEAD` to zero
  length (`proto/h1/role.rs:974`–`:980`) and a `HEAD` response has no content (RFC 9110 §9.3.2). A
  `HEAD` upgrade first on a connection gets `ws`'s exact bytes, body included, through the raw path.
- **Recorded difference (T1a.3's HTTP/1.0 upgrades on a reused connection)**: an upgrade candidate
  whose request line is HTTP/1.0, arriving after an ordinary request on a keep-alive connection, is
  refused with a `400` and the connection closes; Node hands it to the `upgrade` listener and `ws`
  switches it. The bytes are `ws`'s `abortHandshake` form — `Connection: close`,
  `Content-Type: text/html`, `Content-Length: 25`, body `Upgrade requires HTTP/1.1` — with hyper's
  lower-case field names (the difference above) and its `HTTP/1.0` status line, because hyper
  mirrors the request's version there (`proto/h1/conn.rs:708`). The refusal comes before
  admission: nothing is reserved or opened, since hyper upgrades HTTP/1.1 only
  (`proto/h1/role.rs:336`) and a `101` for any other version would leave the client with no socket
  behind it. No ace client sends one (browsers, iOS and the CLI upgrade over HTTP/1.1), and an
  upgrade first on a connection is unaffected: it gets `ws`'s `101` for any version, as Node does.

## 4. Liveness and idle

- A **ping** is a text frame of at most 64 bytes that is exactly `{ "type": "ping" }`
  (`socket-liveness.ts:3`–`:17`); it is answered with `{ "type": "pong" }` as it arrives, never
  behind queued handlers (`socket-input.ts`, comment at `:32`), so a slow handler cannot fail a
  peer's heartbeat.
- A socket with no activity for `idleTimeoutMs` (default 60 s) is closed with `4008 Idle timeout`
  (`server.ts:679`). The sweep runs every `max(10, min(1000, idleTimeoutMs / 2))` ms
  (`server.ts:1221`) and also expires account grants (`4014 Account grant expired`,
  `account-access/grant-lease.ts:9`) and revalidates org standings.
- **Wedged daemon**: today a pong needs the JavaScript thread, so a daemon whose thread is stuck
  stops answering and its clients reconnect elsewhere or report it. A Rust transport answering
  pings on I/O threads must keep that: it stops answering when the core's pump has not completed
  a turn within the heartbeat window (ADR 0226 §2).

## 5. Closing

- **Close codes are contract.** At least: `4001 Credential replaced`, `4008 Idle timeout`, `4009`
  with two reasons (`Message backpressure` for input, `socket-input.ts:63`; `Reconnect with
afterSeq` for an outbox that can't keep up, `RESYNC_CLOSE_CODE`, `outbox.ts:13`, `:349`),
  `4013 connection_limit`, `4014 Account grant
expired`, `1009` for an oversized message, `1011 service_unavailable` when finishing a hello
  fails (`server.ts:942`). A builder lists every `close(` and `gracefulClose(` call site before
  porting and keeps each code and reason.
- A deliberate close sends its frame when the socket can carry it, then drops the socket after at
  most `DAEMON_CLOSE_GRACE_MS` (1 s, `server-socket-close.ts:10`). Idempotent per socket; a socket
  already closing keeps its own code; one still connecting gets its code once open
  (`server-socket-close.ts:26`–`:32`).
- A session's cleanup runs before the wire goodbye; a revoked device's sessions get `revoked()`
  while the socket is still open, then close (`services/socket.ts`).
- **Recorded difference (T1b.4, an upgrade that finishes while its listener retires)**: turning
  remote access off, or moving the listener to another address, retires the listener with deadline 0. An upgrade whose `101` was still being written when the retire began is terminated as soon as
  it is registered; with `node:tls` such a socket could survive the retire
  (`sni-listener.ts:172`–`:180` dropped it from `owned`), which was never intended. A daemon
  shutdown gives it `1001 Daemon shutdown` instead, as every other socket gets.
- Closes worth explaining are logged without identifying a person or device: heartbeat loss,
  limits, auth, daemon-initiated closes; unauthenticated ordinary closes (`1000`, `1001`, `1005`)
  are not (`socket-liveness.ts:24`–`:71`).

## 6. Hello, authentication and device identity

- The first message on a main socket is `hello` (`protocolVersion`, `deviceId`, a credential,
  optional `channel`, `framing`, `trim`, `compression`). The welcome follows only after every
  service's `authenticated()` resolved; a rejection with code `limit` refuses the socket as over
  capacity (`services/socket.ts`).
- **Refused hellos**: a first frame that is binary, even one holding a valid hello, and a hello
  that authenticates nothing get `{type: "error", code: "unauthorized"}` and close with `4001`,
  sending no data first; a second hello on an authenticated socket closes it without another
  welcome or heartbeat (`auth.server.process.test.ts:20`–`:40`).
- **Welcome before pushes**: services' `welcomed()` runs after the welcome is on the wire
  (`server.ts:923`; on an NK stream after `hello.confirmed`, `:755`–`:756`), and no service may
  push before it; a client's first message after its
  hello is always the welcome or a refusal.
- **Credentials** (`socket-hello.ts`): the host token counts only on loopback and is never
  revocable; a ticket or a desktop bearer must name the device the hello claims and stays
  revocable; the "Use my Chrome" native host's credential authorizes only registering a browser
  link (ADR 0084). A paired device names its app install, so its records fold into one (ADR 0115).
- **Tickets** (`ticket-pool.ts`, `remote-auth.ts`): one use each; at most 10,000 outstanding in all,
  32 outstanding per device, and 120 issued per device per minute (`ticket-pool.ts:8`–`:12`; each
  limit refuses with `429`); each valid 60 s; bound to the device and the credential
  generation that asked, and to the host key epoch that handed it (ADR 0155). They live **in
  memory only** (`TicketPool`; `clearPending` replaces it), so a restart voids every outstanding
  ticket and a client exchanges a fresh one with its persisted device token (`/v1/tickets`); a
  ticket asked for with a credential since replaced opens nothing.
- **Two spending rules, not one** (keep them apart):
  - **Direct hello** (`socket-hello.ts:27`–`:40`, `remote-auth.ts:209`–`:216`): the ticket is
    **consumed first**, then its device is checked against the hello's `deviceId`; a mismatch
    refuses the hello, and the ticket is spent anyway.
  - **NK first message** (`remote-auth.ts:218`–`:231`, `relay-nk/`): the relay key epoch and the
    claimed device are **checked before** the ticket is taken, so a message refused for an epoch or
    claimed-device mismatch spends nothing. A matching ticket is spent in one synchronous step, so
    exactly one of two racing copies gets it, before the session is confirmed. Refusals decided
    after that step spend it: a credential generation since replaced or a local-only device
    (`remote-auth.ts:224`–`:231`), and the actor's admission (`relay-nk/host.ts:63`–`:67`,
    `mainActor`). What the hello does to the device (`touch`, install folding) waits for
    confirmation.
  - A ticket handed over in a welcome (`handOver`, ADR 0150) is one-use, as short-lived and as bound
    as an exchanged one, and voided by revocation the same way.
- **Pairing** (`remote-auth.ts:86`–`:140`, `pairing-codes.ts`, `pairing-issue.ts`): a link's code is
  **single use** (`take` removes it as it returns it, so one code never pairs two devices); it
  expires after `ttlMs` (default 5 minutes); at most 100 links are pending; redemption attempts are
  limited to 5 per source address and 100 overall per minute (`remote-auth.ts:313`–`:319`, `429`).
  Links are stored by the code's SHA-256 in the database, so a restart doesn't void one being
  scanned, and each still ends at its expiry. Desktop and browser-link scopes can't be granted by a
  link. A new paired credential replaces the old one and closes its sockets with `4001`.
- **Files and pins** (`local-files.ts`, `tls-identity.ts`): the data directory is made private
  (`secureDataDir`); the daemon token is 64 hex characters in `daemon-token`, created exclusively
  with mode `0600` and set to `0600` on every start (`local-files.ts:84`–`:95`), and compared in
  constant time (`validToken`); the persistent keys (Suit URL key, Spade person key, push key) and
  host id are kept the same way. The TLS identity lives under the home's `tls/` and its pinned
  fingerprint is the SHA-256 of the certificate's public key (`tls-identity.ts`); a port loads the
  existing files and never regenerates them while they're valid, so every paired device's pin
  still matches after the move (pin continuity).
- **Account devices** (ADR 0111, ADR 0190): grants on the socket, refreshed by the channel, closed
  with `4014` when they lapse; person proof (`personProven`) is a paired device or an account
  device whose standing grant says person, never the host token.
- **Org hosts** (ADR 0206, ADR 0209): standings checked at admission and again when a command's
  lane runs it; a lapsed standing ends every live handle its member held.

## 7. Input

- Authenticated handlers run in order per socket (`socket-input.ts`). A socket stops being read
  once 1 MiB of its input waits (TCP backpressure reaches the peer) and resumes once drained;
  only input past 8 MiB per socket or 16 MiB across sockets closes with `4009 Message
backpressure`; each message is charged 256 bytes on top of its payload (`:21`–`:24`, `:63`).
  Transport buffers that may have carried credentials are not retained after handling.
- **Commands** (`socket-commands.ts`): scope, device and maintenance checks, then the command's
  lane (`command-lanes.ts`): commands that touch the same thread or workspace run one at a time in
  arrival order, whichever socket of the device carried them; a replay after a reconnect lands
  behind the attempt it repeats and finds its receipt. A fast command finishes before the socket
  reads on (250 ms grace); at most 64 commands per socket in flight before its input waits.
- **Core reads** (`socket-reads.ts`): subscriptions, pages, output reads and command status are
  answered in socket order; an output read returns at most its page per reply; an item larger than
  a page arrives reduced or summarized, never as a failed page.

## 8. Output

- **Outbox** (`outbox.ts`): one byte budget shared by every outbound frame type: sustained
  pressure at 256 KiB, hard limit 4 MiB of queued plus transport bytes, 5 s at the hard limit before
  the socket is closed for resync (`:25`–`:28`). Service envelopes may carry a 1 MiB artifact.
- **Frame packing** (`frame-holder.ts`) once the hello says `framing: ["lines"]`: only messages made
  entirely of streamed text may wait to share a frame: 16 ms on loopback or a link that keeps up,
  100 ms past an 8 KiB backlog, 250 ms past 64 KiB; a packed frame goes at 64 KiB whatever the
  clock. Anything a person or request waits on goes at once, taking what waits before it. Order and
  content are exactly as sent (`ordered-socket.ts`: a service's write first releases what the
  outbox holds, so a held delta never falls behind a later reply).
- **Event shapes** (`wire-encoder.ts`): `raw-on-demand` sends item events without raw payloads;
  `short-deltas` sends deltas in short form, naming their thread once per message; a delta of
  another thread goes whole. `events` messages split at 1 MiB of event bytes
  (`eventFrameBytes`), each split frame carrying `afterSeq`/`throughSeq`; one larger event travels
  alone.
- **Each event is serialised once** for everyone who weighs or sends it, whole and at most one
  trimmed form (`event-encodings.ts`); an encoding counts only while the event holds the payload it
  was made from (the store may cap it).

## 9. Subscriptions and fan-out

- Events reach subscribers only after commit (store behaviour.md §4), in sequence order.
- **The handoff from a read to live events** (`subscription.ts:159`–`:221`, `:319`–`:323`), which any
  implementation keeps step for step:
  1. register for live events **before** reading (`routeThread` or `store.subscribe`), and queue
     every batch heard while the subscription initializes;
  2. take the rows and the head watermark **together**: the snapshot and `headSeq()` from one read
     snapshot (today one synchronous step on the JS thread; on a reader pool, one SQLite read
     transaction);
  3. send the snapshot or replay, setting the cursor to the watermark;
  4. drain the queued batches, delivering **strictly above** the cursor, then deliver live batches
     the same way.
- **A bounded replay covers through its watermark, or becomes a snapshot.** `readEvents` stops at
  its byte budget only after including the event that crosses it (`store.ts:1182`), so
  `subscription.ts:283`–`:318` can tell overflow from completion and send a snapshot instead. Any
  implementation's bounded read must either return every event through the head it reports or say
  it overflowed; it must never return a prefix and move the cursor to the head, because the client
  checks only that `afterSeq` matches (`thread-store.ts:374`–`:378`) and would accept the hole.
- **Cursors are contiguous.** Every `events` and `progress` message carries `afterSeq` equal to the
  previous message's `throughSeq` (`:179`–`:198`); events the subscription filters out (another
  thread's, non-sidebar ones) still advance the cursor through a `progress` frame, sent within
  `progressIntervalMs` (250 ms) or at once after a replay. The client refuses a message whose
  `afterSeq` isn't its own sequence as a gap and resyncs (`packages/client/src/thread-store.ts:378`),
  so a hole in the cursors costs a resync, and a skipped event would lose a committed status change
  (priority 1).
- **Thread subscriptions** (`subscription.ts`): a client resuming from `afterSeq` gets a replay of
  what it missed, split into frames of about 1 MiB of event bytes (`:83`), or a full snapshot when
  that costs fewer bytes and ends where the replay would, holding every item created after
  `afterSeq` and every item a missed event changed (ADR 0062); a replay of at most 16 KiB is sent
  without weighing a snapshot (`:103`). Replay is bounded (`replayLimit`, 5,000 events,
  `socket-reads.ts:99`): a list cursor further behind than that, a cursor ahead of the head, or a
  replay that isn't safe gets a snapshot instead (`subscription.ts:240`–`:252`; a thread's replay
  is bounded by its own events, ADR 0128).
- **Read cursors** go with each row, and again when the device marks it read; marks made inside a
  command's transaction are read once it has committed (`subscription.ts:46`–`:58`).
- **Sidebar subscriptions** (`sidebar-subscription.ts`, ADR 0107): every live thread and the newest
  settled page, each with its place in the Threads panel; a change sends only the threads it
  touched; a list resuming from a revision of this database and epoch gets only what changed since.
- Other services push through `SocketContext.send` once `welcomed()` ran.

## 10. Relay

ADR 0155 and `docs/relay/README.md` are the relay's contract; the daemon's side:

- One standing control socket per relay (`/host`, its own Noise session); when a client arrives the
  relay offers a ticket and the daemon dials a fresh `/join`, after which the relay sends the client
  a one-byte readiness marker; early client data closes the stream.
- Streams are `Noise_XX_25519_ChaChaPoly_SHA256` (prologue `ace daemon relay stream v1`), the client
  pinning the daemon's static key (the host id is the base32 of it); returning clients may connect
  with `Noise_NK_25519_ChaChaPoly_SHA256` and `hello.early` (`relay-nk/`), whose ticket is spent by
  §6's NK rule and whose other effects wait for confirmation.
- A relayed close carries the relay's reason ("Peer closed" when the far end went away); any other
  failure is `1006` (`relay-socket.ts`).
- Bulk JSON is compressed per message with raw deflate when the hello asked for
  `compression: ["deflate-raw"]`, under the same allowlist as §2; measured 0.02–0.12 ms per message
  of 1.6–6.1 KB (head-of-line results, 2026-11-15).

## 11. Inventory

What is still TypeScript in `apps/daemon/src` after ADRs 0221 to 0225, by responsibility (982
production modules, 143,980 lines; ADR 0226 has the line counts). Paths are relative to
`apps/daemon/src`, without `.ts`; `services/` entries are the per-socket sessions of each area.
Test files, test support, fixtures, evals and benches are not listed: they move with their modules.

- **Machines** (144): `files-relay`, `machine-tables`, `machine-tunnel/` (6: ace-ports, host, policy, port-feed, relay, wiring), `machine-update/` (9: busy, create, desktop-installer, installer, machine-updates, record, rules, standalone-installer, updater-process), `machines/` (55: caller, capability-hosts, child-ledger, child-liveness, child-lost, child-messages, child-outbox, child-question, child-recheck, child-results, child-schedule, child-views, children, command-host, command-host-shell, command-jobs, command-process, command-rules, command-tools, connections, directory, failure-episodes, fleet-links, grant-rules, grant-store, guest-sessions, held-messages, http, link-routes, link-timing, machine-link, mirror, parent-gone, quiet-backoff, relay-fallback, relay-link, relay-pairing, remote-jobs, retry-backoff, saved-pairings, status-result, target, target-accounts, target-browser, target-devices, target-launches, target-outcomes, target-refusal, target-rejections, target-screen, target-spade, target-threads, tool-result, transport, unconfirmed-stops), `media-relay/` (7: admit, handover, port, runtime-port, streams, testing-producer, testing-relay), `parcels/` (11: descriptions, files, link, messages, puller, quarantine, rules, sender, service, store, target), `services/` (6: fleet, fleet-scope, machine-tunnel, machine-update, machines, transfers), `transfers/` (48: agent, archive-selection, chunk-pace, client, commands, files, http, identity, ignored-files, incoming, incoming-files, incoming-index, incoming-rows, incoming-unconfirmed, landing, landing-made, landing-place, landing-types, live/adapters, live/cutover, live/messages, live/ownership, live/ownership-rules, live/resumes, live/source, live/target, live/target-rows, live/turn-start, outgoing, outgoing-rows, ports, prepare, retry, route-policy, routes, serve, service, service-adapters, sessions/carrier, sessions/claude, sessions/codex, sessions/index, sessions/place, sessions/rewrite, sessions/stage, transfer-identity-support, transfer-index, transfer-live-support).
- **Spade host side, Store, Suits, plugins, skills, icons, previews** (115): `builtin-skill-crash-child`, `builtin-skill-processes`, `builtin-skill-roots`, `builtin-skill-share`, `plugin-launches`, `preview`, `preview-client`, `skill-library`, `skill-usage`, `wasm-wrappers`, `icons/` (11: app-icon, avatar-fetch, avatar-url, favicon-fetch, favicon-image, icon-cache, icon-image, icon-service, linux-app-icon, local-site, public-fetch), `marketplace/` (41: agent-gate, agent-requests, arrived-bots, blocklist, browse, check, content-only, discover, draft-files, fresh-sign-in, git, http, install, journal, listings, looks, market-agent, market-error, open-reviews, options, org-registry, own-profile, package-diff, person-requests, pick, pick-ports, pictures, plugin-port, prepare, publish, publish-request, review, service, sources, spade-bot, spade-port, spade-skills, store, trust, turned-off, upkeep), `preview-suggestions/` (5: page-probe, printed-urls, scope, service, tracker), `services/` (16: icons, marketplace, plugin-availability, plugins, preview-client, prompt-files, skill-library, spade, spade-computer, spade-computers, spade-host, spade-http, spade-remote, spade-session, spade-switch, suits), `spade/` (22: account-grant-http, bodies, computer-drivers, computer-reports, computers, delivery, forward, grant, grant-auth, host-busy, host-thread, image-preview, link, link-runtime, loosen-stamp, member-stamp, notice-alert, notices, person-stamp, remote, rules, service-control), `suits/` (10: http, library, live-checks, looks, port, range, reader, urls, video-http, watch).
- **Daemon lifecycle, settings, notifications, storage, verify, terminal** (100): `app-update-board`, `config`, `daemon-log`, `daemon-surface`, `diagnostic-log`, `expiry-map`, `fatal-log`, `home-backup-log`, `index`, `late-setup`, `notification-ack`, `notification-config`, `notification-intents`, `notification-ownership`, `notification-wake`, `notifications`, `onboarding`, `owned-evidence`, `owned-processes`, `peer-process`, `process-daemon`, `process-priority`, `process-recovery`, `service-crashes`, `settings`, `shutdown`, `shutdown-processes`, `shutdown-receipt`, `stall-log`, `startup-attempts`, `storage-levels`, `storage-reserve`, `storage-watch`, `test-git`, `update-hold`, `background-services/` (3: probe, task-ports, watcher), `services/` (11: app-update, background, background-ports, kill-all, notifications, resources, settings, silence-setting, storage, terminal, verify), `storage/` (35: apply, crash-worker, data-retention, data-retention-policy, delegation-trees, executor, files, inventory, journal, ownership, planner, refusal, schedule, service, skill-roots, space-reclaim, space-reclaim-policy, transcript, types, usage-activity, usage-cache, usage-scanner, usage-schedule, usage-walk, usage-walk-roots, usage-worker, usage-worker-scan, usage-worker-wire, worktree-backups, worktree-batches, worktree-executor, worktree-io, worktree-maintenance, worktree-worker, worktree-worker-wire), `verify/` (16: check-command, check-process, check-trees, forge-port, log-tail, ports, project-check, run-errors, run-execution, run-list, run-logs, run-recovery, run-session, run-state, run-store, verify-service).
- **Agent-control and its publication tools** (83): `html-preview`, `html-publication`, `image-publication`, `knowledge`, `mcp-data`, `measurement-correlation`, `measurement-mcp`, `publish-artifact`, `tool-failure-log`, `tool-result-content`, `agent-control/` (62: account-availability, account-checks, account-names, admission, agent-subtree, ancestor-stop, authorization, catalog, child-status, child-sync, command-id, command-policy, conversation-answer, conversation-journal, conversation-tools, conversations, cursor-request, delegation-origins, delegations, failure, failure-account, failure-result, forks, handoffs, host-delegation, journal, launch-queue, limit-hold, limit-notices, limit-settlement, local-usage-recovery, message-arrival, message-notices, message-senders, model-load-budget, model-roster, models, monitor, owner-thread-executor, owners, peer-messages, previews, projects, provider-facts, queue-control, reservation-lifetimes, results, role-names, run-roles, selection, selection-defaults, snapshot-rows, task-view, thread-automations, thread-lineage, thread-settle, tools, turn-fence, wait-deadline, waiters, watch-view, workspaces), `native-tools/` (4: claude, codex, files, read), `services/` (7: agent-control, agent-control-failure, commands, context, context-scope, handoff-tools, native-tools).
- **Providers and accounts** (81): `account-executable`, `account-homes`, `account-leases`, `account-limits`, `account-limits-schedule`, `account-management`, `account-reset`, `antigravity-settings`, `catalog-claude-discovery`, `catalog-discovery`, `catalog-env`, `codex-login-driver`, `credential-runtime`, `cursor-account-flow`, `cursor-account-terminal`, `cursor-catalog-env`, `cursor-process-check`, `cursor-sandbox-check`, `host-cli-identity`, `installation-gate`, `login-path-handoff`, `opencode-earlier-logins`, `opencode-login-driver`, `pi-login-driver`, `pi-login-worker`, `provider-account-support`, `provider-accounts`, `provider-admission`, `provider-api-key`, `provider-configurations`, `provider-discovery`, `provider-login-acp`, `provider-login-cursor`, `provider-login-driver`, `provider-mcp-add`, `provider-mcp-sources`, `provider-model-availability`, `provider-status`, `provider-status-row`, `role-settings`, `toolchains`, `usage`, `usage-accounts`, `utility-known-cli`, `utility-models`, `provider-install/` (9: admission, failure, planner, prerequisites, registry, release, sessions, testing, versions), `services/` (27: accounts, agent-registry, antigravity, antigravity-accounts, antigravity-skills, catalog, claude, cursor-activation, cursor-auth, cursor-hosts, cursor-instance, cursor-limits, cursor-mcp, login-refusal, models, native-login-guard, permissions, pi, provider-activation, provider-auth-relay, provider-install, provider-login, provider-login-agent, provider-login-prepare, provider-mcp, provider-status, usage).
- **Git and forge callers** (80): `checkout-missing`, `default-branch`, `forge-action-observation`, `forge-backends`, `forge-reply-receipts`, `forge-resource-owner`, `forge-stack-state`, `forge-stack-sync`, `forge-write-lifecycle`, `forge-write-receipts`, `git-diff-cache`, `git-diff-page`, `gitlab-hosted-merge`, `hosted-browse`, `hosted-checks`, `hosted-create`, `hosted-inbox`, `hosted-issues`, `hosted-lifecycle`, `hosted-review-conversation`, `inbox-actions`, `issue-actions`, `managed-worktrees`, `owned-worktree`, `pr-auto-link`, `pr-conflicts`, `pr-create-command`, `pr-create-target`, `pr-head`, `pr-worktree-resolution`, `project-git`, `publication-state`, `pull-request-follow`, `repository-publications`, `review`, `review-executor`, `source-control`, `source-control-prompt`, `tea-source-control`, `workspace-change-clear`, `workspace-forge`, `workspace-forge-actions`, `workspace-forge-browse`, `workspace-forge-checks`, `workspace-forge-context`, `workspace-forge-lifecycle`, `workspace-forge-reviews`, `workspace-forge-stacks`, `workspace-head-watch`, `workspace-issue-links`, `workspace-move`, `workspace-pr-associations`, `workspace-pr-creation`, `workspace-pr-links`, `workspace-pr-new`, `workspace-push`, `workspace-read-queue`, `workspace-refresh`, `workspace-refresh-deadline`, `workspace-repository`, `workspace-reservations`, `workspace-root`, `workspace-roots`, `workspace-runtime`, `workspace-scripts`, `workspace-source-control`, `workspace-store`, `worktree-base`, `worktree-base-resolution`, `forge-media/` (7: media-cache, media-fetch, media-files, media-grants, media-service, media-sniff, media-test-hosts), `services/` (4: repositories, review, source-control, workspace-actions).
- **Store reads and the modules ADR 0222 did not take** (79): `activity-reads`, `bounded-events`, `bounded-item-page`, `canonical-json`, `compressed-files`, `content-encoding`, `conversation-tables`, `entity-retention`, `entity-shape`, `entity-window`, `history`, `history-index`, `history-instances`, `history-message-replay`, `history-publish-worker`, `history-publisher`, `history-review-support`, `history-search-replay`, `history-session`, `history-storage`, `home-data`, `item-clip`, `item-page-capacity`, `item-store`, `item-text-store`, `measurement-store`, `metadata-retention`, `native-image-store`, `native-images`, `ordered-tree`, `run-client-storage`, `sidebar-columns`, `sidebar-facts`, `sidebar-index`, `sidebar-live`, `sidebar-page-storage`, `sidebar-page-weight`, `sidebar-placement`, `sidebar-reads`, `sidebar-revisions`, `sidebar-subscription`, `status-store`, `streaming-blobs`, `text-preview`, `thread-cache`, `thread-cleanup-journal`, `thread-client-storage`, `thread-cold`, `thread-columns`, `thread-gone`, `thread-lifecycle`, `thread-move`, `thread-organization`, `thread-organizer`, `thread-ownership-table`, `thread-read-cache`, `thread-reads`, `thread-row`, `thread-row-indexes`, `thread-row-trust`, `thread-snapshot`, `thread-titles`, `thread-tree`, `tool-result-store`, `tree-root`, `usage-replay`, `services/` (8: activity-reads, history, item-raw, long-thread, search, sidebar-placement, thread-address, thread-organization), `thread-address/` (5: asks, asks-store, context-pack, device-context, plan).
- **Transport: listeners, sockets, HTTP, relay, auth (this ADR, T1 to T6)** (73): `access-http`, `attachment-response`, `attachments-http`, `attachments-upload`, `client-access`, `compression-policy`, `devices`, `devices-setting`, `event-encodings`, `frame-holder`, `host-routes`, `icons-http`, `link-estimate`, `listener`, `main-socket`, `network`, `network-adapters`, `node-tls-identity`, `ordered-socket`, `outbox`, `pairing-codes`, `pairing-issue`, `preview-http`, `relay-account`, `relay-hello`, `relay-http`, `relay-machine-host`, `relay-route`, `relay-socket`, `remote-auth`, `remote-direct`, `remote-direct-policy`, `remote-policy`, `remote-relays`, `remote-runtime`, `remote-status`, `reply-bounds`, `self-signed-certificate`, `server`, `server-http`, `server-socket-close`, `sign-in-pages`, `sign-in-return`, `sni-listener`, `socket-admission`, `socket-commands`, `socket-hello`, `socket-input`, `socket-liveness`, `socket-reads`, `socket-upgrade`, `subscription`, `tailscale-certificate`, `tailscale-command`, `thread-routes`, `ticket-pool`, `tls-identity`, `web-http`, `web-origins`, `wire-encoder`, `wire-interactions`, `relay-nk/` (3: admission, early-reads, host), `services/` (9: admission, host-identity, registry, relay, relay-attachments, relay-channel, socket, socket-message, transports).
- **Engine callers** (54): `acp-agent-cli`, `acp-agent-status`, `acp-catalog`, `acp-engine`, `acp-model-instance`, `answer-gate`, `asks`, `async-commands`, `busy-open`, `busy-refusal`, `child-limit-setting`, `command-events`, `command-lanes`, `command-library`, `command-not-dispatched`, `command-receipts`, `command-status`, `commands`, `creation-drafts`, `creation-failure`, `creation-output`, `creation-preparation`, `creation-progress`, `creation-resource-id`, `creation-setup`, `creation-workspace`, `creation-workspace-journal`, `declared-limits`, `delivery-runtime`, `held-writes`, `history-continuation`, `interaction-reads`, `loop-monitor`, `models`, `needs-you-threads`, `run-checkpoints`, `run-marker`, `run-turns`, `stop-reason`, `stop-record`, `thread-fence`, `unread-answers`, `user-pause`, `work-outcome`, `liveness/` (4: bounded, lease, standing, stop), `services/` (6: creation-session, engine, history-engine, limit-recovery, recovery, thread-transitions).
- **Projects and files** (48): `browser-artifact-files`, `chat-projects`, `download-folder`, `file-export-source`, `files-artifacts`, `files-scope`, `files-support`, `files-workspaces`, `host-open`, `host-open-places`, `host-open-target`, `image-files`, `installed-editors`, `linked-files`, `project-browse`, `project-directory`, `project-favicon`, `project-files-binding`, `project-folders`, `project-identity`, `project-image`, `project-marker`, `project-notes`, `project-origin`, `project-picker`, `project-picker-filesystem`, `project-policy`, `project-remote-key`, `project-remote-key-reader`, `project-repository-config`, `project-roots`, `project-storage`, `projects`, `files-tool/` (13: content-search, folder-watch, io, list-folder, page, relay-files, roots, search-batches, search-hits, test-clock, tool, watch-fanout, wiring), `services/` (2: files, projects).
- **Account and org access** (39): `handoff-access`, `project-access`, `account-access/` (17: app-standing, backend, device-grant, grant-keys, grant-lease, grant-socket, machine-account, machine-code-policy, machine-codes, member-grant, org-credential, org-enrollment, org-socket, owner, relay-host-id, session-file, tables), `org-access/` (12: decide, fleet-refusal, gate, handles, http-gate, mcp-operations, org-probe, principal, socket-operations, socket-wiring, store-trees, trees), `org-host/` (3: link, plan, wire), `org-registry/` (4: keychain, loop, signer, wire), `services/` (1: machine-code).
- **Outside MCP clients** (37): `external-mcp/` (35: access-alerts, access-requests, browser, card-key, card-signature, endpoint-port, grants, oauth/authorize, oauth/base, oauth/cimd, oauth/cimd-fetch, oauth/client, oauth/codes, oauth/consent-page, oauth/metadata, oauth/rate-limit, oauth/redirects, oauth/registrations, oauth/service, oauth/surface, oauth/token, outside, outside-proof, principals, reach, scopes, screen-use, server, spade-contracts, spawn-limits, tables, task-tool, token-files, tokens, tools), `services/` (2: external-mcp, outside-clients).
- **Browser glue** (21): `browser-desktop`, `browser-engine-moves`, `browser-engine-setting`, `browser-forget`, `browser-forget-projects`, `browser-help`, `browser-help-tool`, `browser-profile-scope`, `browser-tab-context`, `browser-tab-excerpt`, `browser-tab-store`, `browser-test-client`, `browser-test-process`, `browser-toolkit`, `browser-turns`, `browsing`, `user-browser`, `services/` (4: browser, browser-transport, browsing, user-browser).
- **Startup, composition and home identity (this ADR, T7)** (18): `computer-name`, `local-files`, `local-token`, `machine-paths`, `server-options`, `services/` (13: composition, feature-off, options, service-criticality, service-order, service-scope, service-slots, service-watch, startup, startup-notice, startup-runtime, types, warmup).
- **Devices and screens remainder** (4): `services/` (4: media, media-connect, media-images, media-service).
- **Doctor remainder (daemon side)** (3): `services/` (3: diagnostics, doctor-runs, support-files).
- **Other** (2): `action-errors`, `services/` (1: utility).
- **Automations remainder** (1): `services/` (1: automations).

**Packages the daemon loads that no ADR moves** (35, 169,364 source lines): `@ace/browser`
(33,717), `@ace/client` (22,656), `@ace/marketplace` (16,478), `@ace/commands` (9,314),
`@ace/media` (9,094), `@ace/service` (7,266), `@ace/files` (6,538), `@ace/accounts` (6,280),
`@ace/models` (5,590), `@ace/context` (4,373), `@ace/plugins` (4,686), `@ace/diagnostics` (3,582),
`@ace/notify` (3,590), `@ace/agent-registry` (3,160), `@ace/preview` (2,757), `@ace/files-native`
(2,616; the client of the Rust files service), `@ace/history-import` (2,613; ADR 0207's Rust reader
does the reading), `@ace/suits` (2,382), `@ace/html` (2,273), `@ace/themes` (2,279),
`@ace/workspace` (2,181), `@ace/search` (2,101), `@ace/terminal` (2,033; Bun's PTY), `@ace/settings`
(1,959), `@ace/usage` (1,916), `@ace/review` (1,744), `@ace/browser-extension` (1,219),
`@ace/orchestrator` (1,121), `@ace/account-grant` (1,089), `@ace/redaction` (918; ADR 0223 ports
each adapter's redaction with its session), `@ace/secure-channel` (761; T6), `@ace/handoff` (440),
`@ace/design-tokens` (273), `@ace/project-picker` (199), `@ace/markit-web` (166; Rust underneath).
`@ace/relay` (the self-hostable relay, `apps/relay`) is imported 54 times for its host side and wire,
which T6 ports. `@ace/ui-core` is shared with the clients; the daemon uses about ten of its pure
entries (`thread-title`, `time`, `spade-chat`, `market`, `providers`, `open-apps`, `thread-place`,
`mention-shares`, `file-references`, `chat-list`). A pure helper both the daemon and a client run
moves only with a WebAssembly build serving the client (the `ace-core-wasm` precedent, ADR 0223), or
the daemon stops needing it; never as a second implementation.

**Partly moved by ADRs 0222 to 0225**: `@ace/provider-kit` (process layer in E2; discovery,
installers, CLI versions and account helpers are not named by any phase), `@ace/projection` (event
folding in store phase 5; `wire-trim`, `short-deltas`, `entity-pages`, `interaction-summary`,
`turn-boundary`, `activity-reads` go with T3 and T4), `@ace/automations` (recurrence and calendar
stay TypeScript, ADR 0225 §4.1), the adapters (Claude's session, the Cursor host child, the
OpenCode plugins and the Pi extension stay JavaScript).

**JavaScript that must stay JavaScript, run as children**: listed in ADR 0226's Context, with the
JavaScript children that need not stay (Windows gates, the native-messaging host, doctor probes,
the daemon's own workers).

## 12. The tests that guard this, and which carry over

Classes as in the other guides: **(a)** behaviour through the socket, HTTP or a public interface,
must pass unchanged with each switch on and off; **(b)** a test of a TypeScript internal, whose
cases move into `#[cfg(test)]` beside the Rust function that replaces it; **—** not part of this
move.

- **(a), the server over its socket**: the 89 `*.server.process.test.ts` files and every other file
  that starts a server (porting guide T1a.8 lists them), among them `socket-admission`, `socket-close-log`,
  `remote-compression`, `tailscale-https`, `access-cors`, `auth`, `handed-ticket`,
  `ticket-allocation`, `devices-access`, `devices-first-use`, `remote-boundaries`, `remote`,
  `remote-restart`, `remote-runtime`, `ownership`, `host-identity`, `maintenance`, `cold-start`,
  `late-setup`, `preview*`, `history`, `search`, `settings`.
- **(a), transport process files**: `server.process`, `socket-liveness.process`,
  `sni-listener.process`, `tls-identity-node.process`, `web-http.process`, `frame-packing.process`,
  `outbox-work.process`, `pairing-codes.process`, `remote-direct.process`, `remote-payloads.process`,
  `remote-cli.process`, `subscription.process`, `sidebar-live.process`, `sidebar-pagination.process`,
  `sidebar-tabs.process`, `wire-trims.process`, the `attachment-*.process` files and
  `attachments.process`, and the ten relay files (`relay-account-machine`, `relay-main`,
  `relay-nk-account`, `relay-nk-compat`, `relay-nk-deadline`, `relay-nk-window`, `relay-nk`,
  `relay-settings`, `relay-socket`, `relay.device`).
- **(a), the program**: the users of `daemon-launch-test-support.ts` and
  `daemon-crash-test-support.ts`, which start the daemon as a separate program; after T7 they start
  `ace-daemon`.
- **(b)**: `wire-encoder`, `server-socket-close`, `socket-commands-recheck`, `subscription-snapshot`,
  `subscription-tail`, `subscription-routing`, `subscription-replay`, `subscription-limits`,
  `sidebar-read-state`, `sidebar-page-weight`, `remote-policy`, `remote-relays`, `remote-status`,
  `relay-close`, `relay-http`, `relay-machine-host`, `relay-nk/admission`, `relay-nk/early-reads`,
  `relay-nk/host`, `relay-nk/tickets`, `icons-http`, `wire-trim`, and `@ace/secure-channel`'s unit
  files. Each builder confirms a file's class by what it imports before moving it: a file that only
  drives the socket is (a) whatever its name.
- **—**: the services' own tests (they guard services, not the transport) run unchanged with every
  transport switch, which is how T1 to T3 prove the bridges.
