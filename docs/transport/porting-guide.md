# Porting the transport to Rust, and leaving Bun

For the builders who move the daemon's transport into `native/daemon` (`ace-transport`) and, at
the end, make `ace-daemon` the program (`ace-daemon-bin`). One work item per branch. Read
[ADR 0226](../adr/0226-the-daemon-leaves-bun.md) and [behaviour.md](behaviour.md) first: the
contract there is what you keep, and behaviour.md §12 lists the tests by class. The rules of the
[engine porting guide](../engine/porting-guide.md) (switches, refusing to start without the native
part, tests run alone with the switch on and off, the cross-mode gate) apply unchanged; this guide
adds what is particular to the transport.

Branch from `ace/daemon-rust-rewrite` once the item's needs are merged, one branch per item
(`ace/rust-transport-<item>`). Load limits on the shared machines: `--maxWorkers=4`,
`CARGO_BUILD_JOBS=4`, no full suite, one bench at a time (below).

## Rules particular to the transport

1. **Clients see nothing change.** Bytes a client parses, close codes and reasons, HTTP statuses
   and headers, the connect sequence's round trips, frame sizes and compression choices are kept.
   A difference is a bug in the port unless ADR 0226 lists it.
2. **Decode the envelope, forward the body.** The transport reads a client message's `type` and
   its routing ids with `ace-json` and hands the message, as received, to its owner. A TypeScript
   owner gets the original string and runs today's Zod decoder (`services/socket-message.ts`);
   never re-encode a message on its way to TypeScript. A Rust owner decodes with its generated
   `ace-protocol` type.
3. **Everything a client parses goes through `ace-json`** (ADR 0225 safeguard 1): server messages
   in their schema's key order, strings as `JsString`, stored JSON spliced as stored. No
   `serde_json` on a wire value.
4. **One route table.** `native/daemon/catalog/routes.json` names each client message type's owner
   (`rust:<crate>` or `js:<service>`) and each HTTP route's (`rust:` or `js:`). It is generated
   from the Zod unions and the registry; `check:daemon-native` fails on a message type without an
   owner. Moving a type to Rust is a one-line change there plus the handler.
5. **Bridges keep order.** `JsSocketService` feeds each socket's TypeScript sessions one ordered
   queue, as `SocketInput` does (`socket-input.ts`); a Rust handler for a type and a TypeScript
   one for the next type on the same socket still run in arrival order. Liveness frames are
   answered on arrival, never behind either.
6. **Decisions on the pump, bytes on tokio.** Anything that reads or changes daemon state (device
   rows, subscriptions, lanes, admission counts) runs on the core's executor (ADR 0223 §4). Accept,
   TLS, framing, compression and socket reads and writes run on tokio. No lock is shared between
   them; they talk through the queues ADR 0223 §4 defines (one scheduling claim, budgeted turns).
7. **No history-sized work on the pump** (ADR 0170): replays, snapshots and pages are bounded;
   wire reads (T4) run on the reader pool.
8. **Secrets never sit in transport buffers longer than a message**: tickets, tokens, pairing
   codes and grants are dropped (and their buffers zeroed where the TypeScript does,
   `socket-input.ts:83`) after handling. Compression follows `compression-policy.ts`'s allowlist,
   ported as data.
9. **Tests move, they don't multiply.** The (a) files of behaviour.md §12 are the proof and are
   not edited, except `socket-test-support.ts` and the launch helpers, which learn the switch. (b)
   cases move into `#[cfg(test)]` beside the Rust function that replaces their module. No parity
   harness, no second suite.

## Who writes the code

The owner's rule (2026-11-23): Opus plans and reviews; code is always written by DeepSeek Flash or
Muse, each from one strict brief. Each task below is one brief, small enough for one builder round.
A brief is the task's section copied whole, plus the rules of this guide. A builder that finds the
brief wrong or incomplete stops and reports; it never fills a gap with its own design. Every task
leaves the daemon working with its switch off (the default), and a task's branch merges only after
an Opus review against the task's "Reviewer checks".

Commands every task uses (from the repository root; load limits apply):

```sh
# Rust, inside native/daemon
(cd native/daemon && CARGO_BUILD_JOBS=4 cargo fmt --all --check \
  && CARGO_BUILD_JOBS=4 cargo clippy --workspace --all-targets --locked \
  && CARGO_BUILD_JOBS=4 cargo test -p ace-transport --locked \
  && cargo deny check bans licenses sources \
  && CARGO_BUILD_JOBS=4 cargo build --release --locked -p ace-daemon-node)
# TypeScript
bun run fmt:check && bun run lint && bun run typecheck
# One test file, switch off, then on (never an empty path: that runs everything)
f=apps/daemon/src/socket-admission.server.process.test.ts
test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
test -f "$f" && ACE_TRANSPORT=native bun --bun x vitest run "$f" --maxWorkers=4
```

Crate versions below are the ones already in `native/daemon/Cargo.lock` or the local registry on
2026-11-23; licences are checked against `native/daemon/deny.toml`'s allowlist (Apache-2.0, MIT,
BSD, ISC, Zlib, Unicode-3.0, Unlicense, CC0) and recorded per crate. Nothing outside that list,
nothing from git, nothing new beyond what a task names.

## Work items

### T0: switches, skeleton, route table (needs ADR 0223 E0; no behaviour)

#### T0.1 Switches and their boot-time resolution

- **Files**: change `packages/provider-kit/src/native-switches.ts`; change
  `tools/daemon-bench/src/daemon.ts` (`daemonEnv`, `:40`) to pass every native switch variable
  (`ACE_STORE`, `ACE_TRANSLATORS`, `ACE_SESSIONS`, `ACE_SUPERVISOR`, `ACE_CORE`, `ACE_ENGINE`,
  `ACE_GIT`, `ACE_TRANSPORT`) through from the bench's own environment, so a bench can compare off
  and on; create `packages/provider-kit/src/native-switches.test.ts`.
- **Types and signatures** (exported):
  `type TransportPart = "loopback" | "remote"`;
  `function transportParts(): ReadonlySet<TransportPart>` (`ACE_TRANSPORT` unset: empty;
  `native`: loopback; `native,remote`: both; anything else throws naming the value, at module load
  as the other switches do);
  `interface SwitchNeed { phase: string; needs: readonly string[] }`;
  `function resolveSwitches(explicit: ReadonlySet<string>, defaultOn: ReadonlySet<string>, needs: readonly SwitchNeed[]): { on: ReadonlySet<string>; fellBack: readonly { phase: string; because: string }[] }`,
  a pure function that throws `NativeSwitchConflict` (message names both phases) when an explicit
  phase's need is off, and otherwise drops default-on phases whose needs are off, transitively.
  The table holds one row now (`transport.remote` needs `transport.loopback`); later phases add
  theirs. `defaultOn` is empty: nothing is default-on.
- **Invariants**: ADR 0226 §6 "Dependent switches resolve together at boot"; switches are read
  once per process, at module load, before anything binds or opens.
- **Stays TypeScript**: all of it (this is the TypeScript switch module).
- **Switch**: `ACE_TRANSPORT`, default off. No code reads `transportParts()` yet.
- **Tests**: `native-switches.test.ts` is new, allowed because no test covers switch resolution
  today (its header says so): a table of `(explicit, defaultOn, needs) → on, fellBack, or throws`.
  Then the existing provider-kit native files, switch off:
  `bun --bun x vitest run packages/provider-kit/src/process-interactive.native.process.test.ts --maxWorkers=4`.
- **Bench**: none.
- **Must not**: change any existing switch's parsing or meaning; read `ACE_TRANSPORT` anywhere
  else; add a dependency.
- **Reviewer checks**: the diff touches only the three files; the table test fails if the
  transitive fall-back or the explicit refusal is removed; `bun run typecheck` and `lint` pass;
  `ACE_TRANSPORT=bogus bun -e 'import("@ace/provider-kit/native-switches")'` throws naming
  `bogus`.

#### T0.2 The `ace-transport` crate

- **Files**: create `native/daemon/crates/ace-transport/Cargo.toml`, `src/lib.rs`, `src/error.rs`;
  change `native/daemon/crates/ace-daemon-node/Cargo.toml` to depend on it (path); update
  `native/daemon/Cargo.lock` with `--locked` builds afterwards. The workspace's `members =
["crates/*"]` picks the crate up.
- **Layout**: `lib.rs` declares `pub mod error;` and nothing else yet; `error.rs` holds
  `#[derive(Debug, thiserror::Error)] pub enum TransportError { #[error("bind {addr}: {source}")] Bind { addr: std::net::SocketAddr, source: std::io::Error }, #[error("listener closed")] Closed }`.
- **Crates**: `thiserror` 2 (MIT OR Apache-2.0, already in the lock). No napi: the crate has no
  Node types (ADR 0222 §1's rule for core crates).
- **Lints**: `[lints] workspace = true`; no `unsafe`, `unwrap`, `expect`.
- **Tests**: none (no behaviour). **Bench**: none.
- **Must not**: add modules or dependencies beyond these; export anything from the addon.
- **Reviewer checks**: `cargo deny check` passes; `cargo build --release -p ace-daemon-node`
  passes; the crate compiles without napi in its tree (`cargo tree -p ace-transport` shows no
  `napi`).

#### T0.3 The route table and its check

- **Files**: create `scripts/generate-transport-routes.ts` and the generated
  `native/daemon/catalog/routes.json`; change `scripts/check-daemon-native.ts` to run the
  generator with `--check` (fails naming the stale file, as `generate-rust-protocol.ts --check`
  does).
- **What it writes**: `{ "messages": { "<type>": "js:main", … }, "http": { "loopback": [ … ], "remote": [ … ] } }`.
  `messages` lists every `type` literal of the unions `SocketMessage` covers
  (`apps/daemon/src/services/socket.ts`: `ClientMessage`, `PluginClientMessage`,
  `SuitClientMessage`, `SuitReportMessage`, `MarketClientMessage`, `BrowserClientMessage`,
  `BrowserBackendClientMessage`, `UserBrowserExtensionMessage`), read from the Zod schemas'
  discriminated-union options, sorted, each owned by `js:main`. `http` lists the chain stages of
  behaviour.md §3 in order (`org-gate`, `mcp`, `spade-grant`, `web`, `attachments`, `icons`,
  `suits`, `preview`, `access` for loopback; `org-gate`, `outside-mcp`, `transfers`,
  `machine-calls`, `web`, `attachments`, `icons`, `suits`, `preview`, `access` for remote), each
  `js`. The check fails when a union gains a type the file lacks, or the file names a type no union
  has.
- **Stays TypeScript**: everything; the table only records owners.
- **Tests**: none new; `node scripts/generate-transport-routes.ts --check` is the check.
  **Bench**: none.
- **Must not**: hand-edit `routes.json`; import daemon internals beyond the schema packages; mark
  anything `rust:`.
- **Reviewer checks**: adding a literal to a union in a scratch change makes `--check` fail;
  `routes.json` is sorted and stable across two runs.

#### T0.4 Baseline measurements (owner-scheduled, no builder)

Items 1, 2 and 3 of "Measurements to schedule", switch off, on the T0 merge commit. They are the
"before" of T1a.

### T1a: the loopback listener in Rust (switch `ACE_TRANSPORT=native`, default off)

What moves: accepting connections on the loopback port, HTTP/1.1 parsing, the WebSocket upgrade
and framing. **What stays TypeScript in all of T1a**: every HTTP handler (reached through a proxy
hop, unchanged), upgrade admission (path, Origin, the 256 cap, pre-auth budgets: Rust asks
TypeScript), hello and authentication, the outbox, frame packing, input backpressure policy (it
calls `pause`/`resume`), pings and the idle sweep, the close-grace closer, the remote listeners,
the relay. Rust implements the `MainSocket` interface (`apps/daemon/src/main-socket.ts`) and
nothing above it.

#### T1a.1 TypeScript seams, no behaviour change

- **Files**: change `apps/daemon/src/socket-upgrade.ts`, `apps/daemon/src/access-http.ts`,
  `apps/daemon/src/server.ts`; create `apps/daemon/src/http-peer.ts`.
- **Signatures**:
  `export type UpgradeDecision = "accept" | "forbidden" | "unavailable" | "drop";`
  `export function upgradeDecision(input: { url: string | undefined; origin: string | undefined; isLocal: boolean; address: string; servesRenderer: boolean; ownOrigin(origin: string): boolean; allowedOrigins: ReadonlySet<string>; full(): boolean; preAuth: PreAuthAdmission }): UpgradeDecision`,
  extracted from `admitUpgrades` (`socket-upgrade.ts:51`–`:72`) and used by it, same order of
  checks (path, Origin only when present and only on loopback, capacity and pre-auth);
  `http-peer.ts`: `export interface HttpPeer { address: string; remotePort: number; localPort: number }`,
  `export function peerOf(request: IncomingMessage): HttpPeer` (a `WeakMap` entry when one was set,
  else the request's socket values, as today), `export function setPeer(request: IncomingMessage, peer: HttpPeer): void`.
  `access-http.ts` reads `sourceAddress` (`:126`) and `/v1/stop`'s ports (`:205`–`:206`) through
  `peerOf`. `server.ts`'s `connected` takes `request?: { headers: IncomingHttpHeaders }` instead of
  `IncomingMessage` (it reads only the User-Agent, `:386`).
- **Invariants**: behaviour.md §2 (upgrade rules, Origin independent of credentials, no Origin
  admitted on loopback) and §3 (Origin on HTTP); `/v1/stop` proves its caller by the connection's
  ports (stop ownership, ADR 0226 §5), so those ports must be the client's real ones.
- **Tests (switch off only; nothing is native yet)**: `socket-admission.server.process`,
  `access-cors.server.process`, `auth.server.process`, `web-http.process`, `cli-stop.process`,
  `daemon-lifecycle.process`, `audit-shutdown.process`, each alone.
- **Bench**: none.
- **Must not**: change any decision, status code, order of checks or log line; add tests.
- **Reviewer checks**: the extracted function is the old body moved, not rewritten (compare the
  diff hunk by hunk); the seven files pass.

#### T1a.2 Rust: the loopback listener and the HTTP proxy hop

- **Files**: create `native/daemon/crates/ace-transport/src/{listener.rs,proxy.rs,peer.rs}`; change
  `lib.rs`, `error.rs`, `Cargo.toml`.
- **Crates** (versions as in the lock): `tokio` 1.54 (`net`, `rt-multi-thread`, `sync`, `macros`,
  `time`; MIT), `tokio-util` 0.7.20 (`CancellationToken`; MIT), `hyper` 1.12 (`server`, `client`,
  `http1`; MIT), `hyper-util` 0.1.21 (`tokio`; MIT), `http-body-util` 0.1.5 (MIT), `http` 1.5
  (MIT OR Apache-2.0), `bytes` 1.12 (MIT).
- **Types and signatures**:

  ```rust
  pub struct Peer { pub remote: SocketAddr, pub local: SocketAddr }
  pub struct ProxyTarget { pub addr: SocketAddr, pub secret: [u8; 32] }
  pub struct UpgradeRequest { pub path: String, pub origin: Option<String>, pub user_agent: Option<String>, pub peer: Peer }
  pub enum UpgradeDecision { Accept, Forbidden, Unavailable, Drop }
  pub trait UpgradeAdmission: Send + Sync + 'static {
      fn admit(&self, request: UpgradeRequest) -> Pin<Box<dyn Future<Output = UpgradeDecision> + Send>>;
  }
  pub struct LoopbackListener { /* addr, CancellationToken, JoinSet of connections */ }
  impl LoopbackListener {
      pub async fn bind(addr: SocketAddr, target: ProxyTarget, admission: Arc<dyn UpgradeAdmission>, sockets: Arc<dyn SocketSink>) -> Result<Self, TransportError>;
      pub fn local_addr(&self) -> SocketAddr;
      pub async fn close(self);
  }
  ```

  (`SocketSink` is T1a.3's.) A non-upgrade request is forwarded to `target` over a fresh
  `hyper::client::conn::http1` connection with its method, path, headers and streamed body,
  after removing every client-sent `x-ace-*` header and adding `x-ace-proxy: <secret hex>`,
  `x-ace-peer-address`, `x-ace-peer-port`, `x-ace-local-port` from `Peer`; the response streams
  back unchanged. An upgrade request is answered by T1a.3.

- **Invariants**: behaviour.md §2 (loopback only binds 127.0.0.1; `port: 0` picks a free port),
  §3 (the chain's answers pass through byte for byte, including CORS headers and `no-store`);
  closing stops accepting, then waits for open connections as `server.close()` does.
- **Tests**: `#[cfg(test)]` unit tests only for the header filter and peer encoding (new code with
  no TypeScript counterpart); the proof is T1a.6's run.
- **Must not**: answer any HTTP request itself; keep a body in memory whole; use `serde_json`;
  bind anything but the address given.
- **Reviewer checks**: a client-sent `x-ace-proxy` never reaches the target; bodies stream
  (no `collect()` on request or response bodies); clippy and deny pass.

#### T1a.3 Rust: the WebSocket upgrade and the socket

- **Files**: create `native/daemon/crates/ace-transport/src/{ws.rs,socket.rs}`; change `lib.rs`,
  `Cargo.toml`.
- **Crates**: `tokio-tungstenite` 0.30 (MIT; `default-features = false`, no TLS, no `connect`)
  and `tungstenite` 0.30 (MIT OR Apache-2.0; `handshake` for `derive_accept_key`). No compression:
  loopback sockets never compress (behaviour.md §2).
- **Types and signatures**:

  ```rust
  pub enum SocketEvent { Message { data: Bytes, binary: bool }, SendDone { id: u64, error: Option<String> }, Error { message: String }, Close { code: u16, reason: Bytes } }
  pub trait SocketSink: Send + Sync + 'static { fn opened(&self, socket: SocketHandle, user_agent: Option<String>, events: mpsc::UnboundedReceiver<SocketEvent>); }
  #[derive(Clone)] pub struct SocketHandle { /* Arc of shared state */ }
  impl SocketHandle {
      pub fn send(&self, data: Bytes, binary: bool, id: u64);
      pub fn close(&self, code: Option<u16>, reason: String);
      pub fn terminate(&self);
      pub fn pause(&self); pub fn resume(&self); pub fn is_paused(&self) -> bool;
      pub fn buffered_amount(&self) -> u64; pub fn ready_state(&self) -> u8;
  }
  ```

  The upgrade: ask `UpgradeAdmission`; `Forbidden` answers `403 Forbidden`, `Unavailable`
  `503 Service Unavailable` (the bodies `refuseUpgrade` writes today), `Drop` closes the
  connection without an answer; `Accept` answers `101` with `Sec-WebSocket-Accept`, takes
  `hyper::upgrade::on`, and wraps it with `WebSocketStream::from_raw_socket(…, Role::Server,
Some(config))`, `config.max_message_size = Some(1 << 20)` and `max_frame_size = Some(1 << 20)`.

- **Invariants** (as `ws` behaves today, which the tests pin): events in arrival order and `Close`
  last; `send` after close reports `SendDone` with an error, never panics; `buffered_amount` counts
  bytes accepted by `send` and not yet flushed to the kernel; `pause` stops reading the socket
  (frames already read are still delivered); `ready_state` goes 1 → 2 → 3; `close` is idempotent
  and sends the close frame with its code and reason; an oversized message emits `Error`, then
  closes with `1009`; a peer's close is answered and reported with its code and reason (`1005` when
  none).
- **Tests**: unit tests only for the ready-state and buffered-amount bookkeeping; the proof is
  T1a.6's run.
- **Must not**: parse, inspect or answer any message (pings included: they stay TypeScript); hold
  a message after it is handed to the sink; block on a JavaScript call.
- **Reviewer checks**: no `serde`, no message parsing in `ace-transport`; every exit path of the
  connection task sends exactly one `Close`.

#### T1a.4 The binding

- **Files**: create `native/daemon/crates/ace-daemon-node/src/transport.rs`; change its `lib.rs`.
- **Exports** (napi 3, translating only, as `supervisor.rs` does with `ThreadsafeFunction`):
  `class NativeLoopback { static start(port: u32, targetPort: u32, secretHex: string, admit: (path: string, origin: string | null, address: string) => Promise<string>, opened: (socket: NativeSocketHandle, userAgent: string | null) => void): Promise<NativeLoopback>; port(): u32; close(): Promise<void> }`
  and `class NativeSocketHandle { listen(events: (kind: string, data: Buffer | null, code: u32, id: number) => void): void; send(data: Buffer, binary: boolean, id: number): void; close(code: u32 | null, reason: string): void; terminate(): void; pause(): void; resume(): void; isPaused(): boolean; bufferedAmount(): number; readyState(): number }`.
  Each inbound message is copied into a new JavaScript `Buffer`, and the Rust copy is zeroed after
  the call (behaviour.md §7: no frame is retained after handling).
- **Invariants**: one `ThreadsafeFunction` per socket, so events keep their order; panics become JS
  errors (napi's `catch_unwind`); the addon never waits synchronously on a tokio task.
- **Tests**: none here. **Must not**: put any decision in the binding.
- **Reviewer checks**: the binding has no logic beyond conversions; `listen` before any event is
  delivered (events queue until then).

#### T1a.5 The TypeScript shell

- **Files**: create `packages/provider-kit/src/native-transport.ts` (addon loading as
  `native-process.ts:99`–`:130` does, with `ACE_TRANSPORT_ADDON`, else `ACE_STORE_ADDON`, else the
  development build; refuses with a message naming the path when `ACE_TRANSPORT` is set and the
  addon is missing) and add `"./native-transport"` to `packages/provider-kit/package.json`
  `exports`; create `apps/daemon/src/native-socket.ts`: `class NativeSocket implements MainSocket`
  over a `NativeSocketHandle`, with `on`/`once`/`off` for `message`, `close`, `error`, `send`
  callbacks matched by id, and `RawData` as `Buffer`.
- **Invariants**: `MainSocket`'s contract as `ws` keeps it (T1a.3's list); a `send` callback runs
  once.
- **Tests**: none new. **Must not**: change `MainSocket`.
- **Reviewer checks**: `native-socket.ts` holds no protocol logic; the type checks against
  `MainSocket` with no casts.

#### T1a.6 Wiring, and the proof

- **Files**: change `apps/daemon/src/server.ts`, `apps/daemon/src/server-http.ts`,
  `apps/daemon/src/listener.ts`; create `apps/daemon/src/proxy-guard.ts`.
- **Behaviour**: with `transportParts().has("loopback")`: the `local` HTTP server from
  `httpChains` listens on `127.0.0.1:0`, wrapped by `proxyGuard(secret, handler)`, which answers
  `403` to a request without the per-boot secret (constant-time compare), removes the `x-ace-*`
  headers and records `setPeer`; `NativeLoopback.start(options.port, internalPort, secret, admit,
opened)` binds the daemon's loopback port; `admit` runs `upgradeDecision` with the server's
  existing `preAuth`, `full` and origin set; `opened` wraps the handle in `NativeSocket`, runs
  `preAuth.track`, and calls `connected(socket, true, { headers: { "user-agent": … } })`. The URL,
  endpoint file and `close()` order (native listener first, then the internal server) are as
  today. Switch off: no code path changes.
- **Invariants**: behaviour.md §§2, 3, 5, 6, 7 as observed over the socket; `/v1/stop` sees the
  client's real ports through `peerOf`.
- **Tests, each alone, off then on**: `socket-admission.server.process`,
  `socket-close-log.server.process`, `auth.server.process`, `access-cors.server.process`,
  `maintenance.server.process`, `server.process`, `web-http.process`, `frame-packing.process`,
  `outbox-work.process`, `socket-liveness.process`, `attachments.process`,
  `attachment-range.process`, `attachment-upload.process`, `attachment-http-budget.process`,
  `attachment-binary.process`, `handed-ticket.server.process`, `ticket-allocation.server.process`,
  `cold-start.server.process`, `cli-stop.process`, `daemon-lifecycle.process`,
  `audit-shutdown.process`. Then every other `fixture()` file, one at a time, by the owner's
  schedule:

  ```sh
  for f in $(grep -rl socket-test-support apps/daemon/src | grep '\.test\.ts$'); do
    test -f "$f" || continue
    ACE_TRANSPORT=native bun --bun x vitest run "$f" --maxWorkers=4 || echo "FAIL $f"
  done
  ```

  Files that use remote listeners or the relay (`remote*`, `relay*`, `tailscale-https`,
  `sni-listener`) keep their remote sockets on TypeScript in T1a and must pass either way.

- **Bench (before is T0.4; after on this task's commit; one at a time, owner-scheduled)**:
  `FANOUT_EVENTS=3000 FANOUT_ROUNDS=3 bun apps/daemon/bench/fanout.ts` with `ACE_TRANSPORT` unset
  and `=native`, interleaved A B A B; then `bun run bench:daemon --runs=3` off and on (T0.1 passes
  the switch through). T1a goes default-on only if neither is worse beyond the bench's
  tolerances; otherwise it waits for T3 (ADR 0226 §6).
- **Must not**: touch the remote listeners, the relay or any handler; move the outbox, pings or
  input policy; add tests; run the full suite or any bench on its own.
- **Reviewer checks**: switch-off diff is inert (every new branch is behind `transportParts()`);
  the 21 listed files pass off and on; `daemon-endpoint` and the `ace serve --json` output are the
  same with the switch on; a request sent straight to the internal port without the secret gets
  `403`.

### T1b: the remote listeners (switch `ACE_TRANSPORT=native,remote`, default off)

Briefed in full after T1a merges and T1b.0 reports, because the TLS listeners carry
per-connection state T1a doesn't have (`sni-listener.ts`'s trusted keep-alive, `:36`–`:50` and
`:83`–`:173`; outside MCP clients' Tailscale identity, `external-mcp/server.ts:251`–`:300`). The
tasks, in order:

1. **T1b.0 Deflate spike (a written report, no merge)**: ADR 0226 answer 1. Candidate crates with
   RFC 7692 server support, each with its licence, maintenance and whether it supports
   no-context-takeover per message and a post-inflate limit; a throwaway prototype against
   `remote-compression.server.process.test.ts`. `tungstenite` 0.30 refuses RSV1 frames
   (`src/protocol/mod.rs:643`).
2. **T1b.1 TLS termination**: `rustls` 0.23.46 (Apache-2.0 OR ISC OR MIT) with
   `default-features = false` and the `ring` provider (`ring` 0.17: Apache-2.0 AND ISC; the
   `aws-lc-rs` default is not used), `tokio-rustls` 0.26.6 (MIT OR Apache-2.0); the key and
   certificate TypeScript already loads from `tls/` (`tls-identity.ts`) passed as PEM bytes, never
   regenerated (pin continuity); SNI with the Tailscale certificate.
3. **T1b.2 Per-connection state and peer identity** through the proxy hop (trusted keep-alive,
   Tailscale peer), with the remote chain unchanged.
4. **T1b.3 Per-message deflate** as the spike decided, with allowlisted outbound compression and the
   1 MiB post-inflate cap.
5. **T1b.4 Run-time toggling** (`remote-runtime.ts`, `remote-direct.ts`) of the native remote
   listeners, with `remoteStarted`'s semantics.

Proof: `remote.server`, `remote-boundaries.server`, `remote-runtime.server`, `remote-restart.server`,
`remote-compression.server`, `tailscale-https.server`, `sni-listener.process`,
`tls-identity-node.process`, `remote-direct.process`, `remote-payloads.process`, off and on. Bench:
items 5 and 6 of "Measurements to schedule", direct path.

### T2: hello, authentication, devices (needs T1, store phase 5's writer default-on)

`socket-hello.ts`, `remote-auth.ts`, `ticket-pool.ts`, `pairing-codes.ts`, `pairing-issue.ts`,
`devices.ts`, `client-access.ts`, `local-token.ts`, `relay-hello.ts`' account hello, the account
grant socket (`account-access/grant-socket.ts`, `grant-lease.ts`), the org socket policy's
admission checks (`org-access/socket-wiring.ts`). Device rows and pairing links through `ace-store`
on the main connection, under the Rust writer's transaction stack; tickets stay in memory.

Keep behaviour.md §6 rule for rule, in particular:

- the two ticket spending rules: a direct hello consumes and then checks the device; an NK first
  message checks epoch and device and then spends atomically, before confirmation;
- one-shot pairing codes, their expiry, the 100-pending cap and the 5-per-address, 100-overall
  per-minute redemption limit;
- the token file's mode (`0600`, set on every start), constant-time comparison, and the persistent
  keys and TLS identity loaded, never replaced;
- refused hellos (binary first frame, unauthenticated, duplicate) and welcome before any push.

Rollback gate (cross-mode list, both directions): a restart on the other backend keeps persisted
pairings, devices and their credential generations; voids every outstanding ticket, since tickets
live in memory; and a paired device then mints a fresh one with its device token and reconnects.
Files: `auth.server`, `handed-ticket.server`, `ticket-allocation.server`, `remote-restart.server`,
`relay-nk.process`.

### T3: subscriptions and fan-out (needs T2, so the writer is on)

`subscription.ts`, `sidebar-subscription.ts`, `wire-encoder.ts`, `event-encodings.ts`,
`wire-interactions.ts`, `socket-reads.ts`, `socket-commands.ts`, `command-lanes.ts`,
`@ace/projection`'s `wire-trim` and `short-deltas`, and what T1 left above the `MainSocket` seam:
`outbox.ts`, `frame-holder.ts`, `ordered-socket.ts`, `socket-input.ts`, pings and the idle sweep
(`socket-liveness.ts`, `server.ts:679`, `:1221`), `server-socket-close.ts`, with the wedged-daemon
guard of ADR 0226 §2. Events come from `ace-store`'s publication,
whichever engine wrote them; there is no event bridge and E5 is not needed. The process uses the
Rust encoder for every socket or the TypeScript one for every socket, chosen at boot. The
subscription handoff (behaviour.md §9: register, read rows and watermark together, buffer, drain
strictly above, contiguous cursors through progress frames) is ported step for step. Snapshots
and pages are still read by TypeScript in T3 and handed over as strings.

### T4a, then T4: reads to the wire (needs T3)

ADR 0226 §4. **T4a first**: the lenient decoder for untrusted rows ported to Rust, proven by
`stored-history-trust`, `stored-trust-*` and `item-store-trusted-reads` and by
`check:wire-fixtures` over the trust tests' legacy rows; no wire read is enabled before T4a is
default-on, so no reader-pool read ever calls into JavaScript. **Then T4**: items pages and windows,
then snapshots, then the sidebar once `ThreadCache` is fed by the Rust writer. `turnsPage`,
`turnSteps` and `threadCatchUp` are not T4's: store phase 2 owns them and adds their wire encoding.
Trusted rows are spliced as stored. Each wire read keeps the handoff of behaviour.md §9 on the
reader pool (one read transaction for rows and watermark; a cancelled read drops its snapshot and
sends nothing). When a wire read goes default-on, its JavaScript callers move to a facade parsing
the Rust bytes in the same release; the TypeScript shaper remains only as the switch-off path and is
deleted, with the switch, one release later.

### T5: HTTP routes (needs T1 and ADR 0225 M2)

The chains of behaviour.md §3, in their order. A route not yet in Rust is a `JsHttpRoute` in its
position. Port `access-http.ts` with T2; `attachments-http.ts`, `attachments-upload.ts` and
`attachment-response.ts` with the store; `web-http.ts` (static files, the web root) and
`icons-http.ts` early; `preview-http.ts` with the preview owner; Suits with their owner.

### T6: relay (needs T2)

`relay-socket.ts`, `relay-machine-host.ts`, `relay-route.ts`, `relay-http.ts`, `relay-nk/`,
`services/relay-channel.ts`, `services/relay-attachments.ts`, `@ace/relay`'s host side, and
`@ace/secure-channel` replaced by `snow`. `@ace/secure-channel`'s vector files
(`noise-nk-vectors`, `media-vectors`) run against the Rust implementation through the binding.
Built with the machines ADR's relay link.

### T7: the inversion (needs `scripts/check-inversion.ts` to pass)

`ace-daemon-bin`'s `main`, ported from `index.ts` with `config.ts`, `local-files.ts`,
`services/service-order.ts`, `services/startup*.ts`, `services/composition.ts`, `shutdown*.ts`,
`process-daemon.ts`, `daemon-log.ts`, `fatal-log.ts`, `stall-log.ts`; the launcher change in
`@ace/service` (`daemon-program.ts`, `process-names.ts`, `launcher.ts`).

- `scripts/check-inversion.ts` implements ADR 0226 §5's gates: zero production `Store.atomic`,
  `write` and `maintenance` callers in the bundle's production graph; zero production JavaScript
  bridges (route table all `rust:`, and the bridge counters of a started daemon at zero); no
  `@anthropic-ai/claude-agent-sdk` in the bundle; recurrence and argument wording in Rust; every
  switch default-on for a release.
- The fallback release ships the Bun daemon whole at `daemon-bun/ace.mjs` with its own assets,
  addon and `node_modules`. `ACE_DAEMON=bun` makes the launcher start that entry directly. The old
  `ace.mjs` is a shim: `ACE_DAEMON=bun` imports `daemon-bun/ace.mjs`, anything else executes
  `ace-daemon`; it never routes a forced fallback back into Rust.
- Gates on installed artifacts (a built release, not a development tree): the previous release's
  updater launching the new release; forced fallback through the launcher and through the old
  `ace.mjs` path; one home started native, then Bun, then native, with a paired device reconnecting
  and a working thread resuming at each step.

### T8: packaging (needs T7 default-on for one release)

`tools/release/src/daemon-runtime.ts`, `bundle.ts`, `build.ts` and the smoke tests: `ace-daemon` in
every layout; `daemon-bun/` removed; Bun moved to a children-only runtime with each child bundled
on its own. Bun ships in every release while any supported feature needs a JavaScript child (ADR
0226 answer 4).

## Measurements to schedule

None of these has been run for ADR 0226. They run **one at a time** on a quiet machine, when the
owner schedules them, never beside another bench; if a switches-off-versus-on run of another bench
covers the same workload, its off-side numbers are the baseline and are cited with its date and
commit. Every run uses a throwaway home (the benches make their own under the OS temp folder),
never `~/.ace` or a copy of it.

Setup once per checkout: `bun install`, then the native parts the daemon needs from source:
`bun run --filter @ace/workspace build:native` and `bun run --filter @ace/terminal prepare-native`
(without the first, adding the bench's project fails with `project_path_changed`).

1. **Transport share of daemon CPU, per turn and at idle.** The daemon bench with Bun's CPU
   profiler, run from source so the profile names source files. A shim on `PATH` adds the profiler
   only to `serve`, and the bench runs on Node so it finds the shim (`bunBinary` uses `PATH` when
   not on Bun):

   ```sh
   mkdir -p /tmp/ace-0226/{bin,prof,idle,turns}
   cat > /tmp/ace-0226/bin/bun <<EOF
   #!/bin/sh
   case " \$* " in
     *" serve "*) exec $(command -v bun) --cpu-prof --cpu-prof-interval=500 --cpu-prof-dir=/tmp/ace-0226/prof "\$@" ;;
     *) exec $(command -v bun) "\$@" ;;
   esac
   EOF
   chmod +x /tmp/ace-0226/bin/bun
   # idle only (startup, 10 s settle, warm-up turn, 60 s idle)
   PATH=/tmp/ace-0226/bin:$PATH node tools/daemon-bench/src/run.ts --entry=apps/daemon/src/cli.ts \
     --idle-ms=60000 --new-threads=0 --same-thread-turns=0 --long-text-turns=0 \
     --output=/tmp/ace-0226/idle.json && mv /tmp/ace-0226/prof/* /tmp/ace-0226/idle/
   # turns only (standard 20 new-thread, 40 same-thread and 3 long-text turns)
   PATH=/tmp/ace-0226/bin:$PATH node tools/daemon-bench/src/run.ts --entry=apps/daemon/src/cli.ts \
     --idle-ms=0 --output=/tmp/ace-0226/turns.json && mv /tmp/ace-0226/prof/* /tmp/ace-0226/turns/
   ```

   Each run writes two profiles (the layout start and the measured start); use the second. Then
   attribute every sample to the nearest stack frame whose URL is in this repository, and count it
   **transport** when that frame's file is one of behaviour.md §11's transport modules,
   `services/socket*.ts`, `services/registry.ts`, `@ace/projection`'s `wire-trim` and
   `short-deltas`, `@ace/relay`, `@ace/secure-channel` or `node_modules/ws`; **wire encoding** when
   it is `wire-encoder.ts`, `event-encodings.ts` or a `JSON.stringify` called from them. Report both
   self-attributed and inclusive (any transport frame on the stack) shares, per run, with the
   profile's sample count. A startup-only run (every phase option above set to 0) is subtracted from both. Also report `cpuMsPerTurn`, `heapUsed` and `rss` from
   the JSON outputs.

2. **Fan-out cost per subscriber**: `FANOUT_EVENTS=3000 FANOUT_ROUNDS=3 bun apps/daemon/bench/fanout.ts`
   (daemon CPU per committed event with 1, 3 and 6 subscribers; the slope is the per-subscriber
   encode and send cost).
3. **Allocation per subscriber**:
   `bun apps/daemon/bench/allocation-rate.ts --subscribers=1` and `--subscribers=6`, same
   `--events` and `--windows` (bytes allocated per 1,000 deltas, from JSC's GC log).
4. **Inbound decode**: `bun apps/daemon/bench/socket-message.ts` (CPU and allocation per inbound
   message from parsed JSON to the typed message).
5. **Latency under load**: `bun apps/daemon/bench/head-of-line.ts` for the direct and relay paths
   (`stopAck`, `sendReceipt`, event-loop gaps, deflate time), the baseline for T1 and T7.
6. **Relay and slow links**: `bun run --filter @ace/daemon bench:slow-link`,
   `bun apps/daemon/bench/relay-connect.ts` and `relay-resume.ts`, the baseline for T6.
7. **Reads**: `bun apps/daemon/bench/sqlite-store.ts --split` on an APFS clone (as ADR 0222 ran it:
   no daemon on the clone), `bun apps/daemon/bench/thread-open-bytes.ts` and
   `bun apps/daemon/bench/sidebar-live.ts`, the baseline for T4.

Each phase reruns the items its gate names with its switch off and on, interleaved (A B A B), and
reports medians with the load average.

## Counting

ADR 0226's inventory assigns each production module of `apps/daemon/src` (not `*.test.ts`, test
support, fixtures, evals or benches) to one responsibility by its path: `services/<name>.ts` by the
area its session serves, everything else by the first matching prefix rule (for example `^socket-`,
`^relay-`, `^server` → transport; `^workspace-`, `^pr-`, `^hosted-` → git and forge callers;
`^machines/`, `^transfers/`, `^parcels/` → machines), then marks it covered when an ADR's phases
name it (the CLI and doctor directories, the store's connection, writer and long-thread modules,
`engine/` and `native-engine/`, `automation-*`, `computer-locked-use`, `computer-tools`,
`computer-using`, the locked-use and screen modules, the MCP server's daemon modules). Startup,
composition and home-identity modules (`services/startup*`, `composition`, `service-*`,
`server-options`, `local-files`, `local-token`, `machine-paths`, `computer-name`) are their own group,
T7's, apart from the listener work. A builder who finds a module in the wrong group moves it in
behaviour.md §11 in the same change; the totals there and in the ADR are updated together.

## When you are done

- Every (a) file of the item passes alone with the switch on and off, on macOS, Linux and the
  Windows VM; the cross-mode list passes both ways.
- The bench items the phase names are no worse, with numbers in the PR.
- The route table, behaviour.md and the inventory say what moved.
- `cargo fmt --check`, `cargo clippy --all-targets`, `bun run check:daemon-native` and
  `bun run fmt:check` pass.
