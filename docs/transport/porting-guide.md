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
   (`rust:<crate>` or `js:main`) and each HTTP stage's (`rust:<crate>` or `js`). It is generated:
   message types from the Zod schemas, owners and HTTP stages from `scripts/transport-owners.ts`,
   the one place ownership changes (T0.3); `check:daemon-native` fails when they disagree. Moving a
   type to Rust is a one-line change there plus the handler.
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
# Rust, inside native/daemon (from T0.2 on; T0.1 runs only the TypeScript commands)
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
  `ACE_GIT`, `ACE_TRANSPORT`) and the addon paths (`ACE_STORE_ADDON`, `ACE_TRANSPORT_ADDON`)
  through from the bench's own environment, so a bench can compare off and on. The bench bundles
  the daemon into a temporary directory, so the development-build path a shell resolves from its
  own file doesn't exist there: the bench refuses to start when `ACE_TRANSPORT` is set without an
  **absolute** `ACE_TRANSPORT_ADDON`. Change `scripts/test-home-policy.ts` (`:115`–`:129`, where
  the other switches are allowlisted) so test workers and launch helpers keep `ACE_TRANSPORT`,
  `ACE_TRANSPORT_ADDON` and `ACE_TRANSPORT_EVIDENCE` (T1a.8). Create
  `packages/provider-kit/src/native-switches.test.ts`.
- **Commands**: the TypeScript ones only. The Rust block starts with T0.2, which creates the
  crate it tests.
- **Types and signatures** (exported):
  - `type TransportPart = "loopback" | "remote"`;
  - `interface SwitchNeed { phase: string; needs: readonly string[] }`;
  - `function resolveSwitches(explicit: ReadonlySet<string>, defaultOn: ReadonlySet<string>, needs: readonly SwitchNeed[]): { on: ReadonlySet<string>; fellBack: readonly { phase: string; because: string }[] }`,
    pure. **Order**: the initial set is `explicit ∪ defaultOn`. Fallback applies only to
    default-only phases (in `defaultOn` and not in `explicit`): each one whose needs aren't all in
    the set leaves it, repeated until nothing changes, each recorded in `fellBack`. Then every
    explicit phase (including one that is also default-on) is checked against the final set; one
    with a need that isn't in it throws `NativeSwitchConflict`, naming both phases. So an explicit
    phase whose need fell back as a default is refused, not silently started.
  - `function transportParts(): ReadonlySet<TransportPart>`, derived from the resolver's `on` set,
    which the module computes once at load from the environment (`ACE_TRANSPORT` unset: nothing
    explicit; `native`: `transport.loopback`; `native,remote`: both; any other value throws naming
    it, as the other switches do).
  - The table holds one row now (`transport.remote` needs `transport.loopback`); later phases add
    theirs. `defaultOn` is empty: nothing is default-on.
- **Invariants**: ADR 0226 §6 "Dependent switches resolve together at boot"; resolution happens
  once per process, at module load, before anything binds or opens.
- **Stays TypeScript**: all of it. **Switch**: `ACE_TRANSPORT`, default off; nothing reads
  `transportParts()` yet.
- **Tests**: `native-switches.test.ts` is new, allowed because no test covers switch resolution
  today (its header says so): a table of `(explicit, defaultOn, needs) → on, fellBack, or throws`,
  including a default fallback that makes an explicit phase throw and a phase present in both
  sets (treated as explicit). Then, switch off,
  `bun --bun x vitest run packages/provider-kit/src/process-interactive.native.process.test.ts --maxWorkers=4`.
- **Bench**: none. **Must not**: change any existing switch's parsing or meaning; read
  `ACE_TRANSPORT` anywhere else; add a dependency.
- **Reviewer checks**: only the four files change; the table test fails if the transitive
  fall-back, the ordering or the explicit refusal is removed;
  `ACE_TRANSPORT=bogus bun -e 'import("@ace/provider-kit/native-switches")'` throws naming `bogus`.

#### T0.2 The `ace-transport` crate (ready)

- **Files**: create `native/daemon/crates/ace-transport/Cargo.toml`, `src/lib.rs`, `src/error.rs`;
  change `native/daemon/crates/ace-daemon-node/Cargo.toml` to depend on it (path); update
  `native/daemon/Cargo.lock`. The workspace's `members = ["crates/*"]` picks the crate up.
- **Layout**: `lib.rs` declares `pub mod error;` and nothing else yet; `error.rs` holds
  `#[derive(Debug, thiserror::Error)] pub enum TransportError { #[error("bind {addr}: {source}")] Bind { addr: std::net::SocketAddr, source: std::io::Error }, #[error("listener closed")] Closed }`.
- **Crates**: `thiserror` 2 (MIT OR Apache-2.0, already in the lock). No napi: the crate has no
  Node types (ADR 0222 §1's rule for core crates). `[lints] workspace = true`.
- **Tests**: none (no behaviour). **Bench**: none.
- **Must not**: add modules or dependencies beyond these; export anything from the addon.
- **Reviewer checks**: `cargo deny check bans licenses sources` and the release build pass;
  `cargo tree -p ace-transport` shows no `napi`.

#### T0.3 The route table and its check

- **Files**: create `scripts/transport-owners.ts` (the one place ownership changes), the generator
  `scripts/generate-transport-routes.ts`, and its output `native/daemon/catalog/routes.json`;
  change `scripts/check-daemon-native.ts` to run the generator with `--check` (fails naming the
  stale file, as `generate-rust-protocol.ts --check` does). This replaces rule 4's "generated from
  the registry": message types come from the schemas; owners and the HTTP stages come from
  `transport-owners.ts`.
- **Schema entry points**: `ClientMessage` (`@ace/protocol`, `wire.ts:243`, a discriminated
  union), `BrowserClientMessage` (`browser.ts:527`, discriminated union),
  `BrowserBackendClientMessage` (`browser-backend.ts:112`, discriminated union),
  `UserBrowserExtensionMessage` (`user-browser.ts:118`, a plain `z.union`), and the strict objects
  `PluginClientMessage` (`@ace/protocol/plugins`, `plugins.ts:271`), `SuitClientMessage` and
  `SuitReportMessage` (`@ace/protocol/suits`, `suits.ts:399`, `:484`), `MarketClientMessage`
  (`@ace/protocol/marketplace`, `marketplace.ts:627`), the union `SocketMessage` covers
  (`apps/daemon/src/services/socket.ts`). The generator walks each schema: a discriminated or
  plain union recurses into its options; an object (strict or not) contributes its `type` field's
  literal (or every value of a literal union or enum); anything else, or an object without a
  literal `type`, fails the generator naming the schema.
- **Owners file**, in chain order for the stages (behaviour.md §3):

  ```ts
  type Owner = "js:main" | `rust:${string}`;
  export const messageOwners: Record<string, Owner> = {}; // overrides; every other type is js:main
  export const httpStages: readonly {
    listener: "loopback" | "remote";
    stage: string;
    owner: "js" | `rust:${string}`;
  }[] = [
    // loopback: org-gate, mcp, spade-grant, web, attachments, icons, suits, preview, access
    // remote: org-gate, outside-mcp, transfers, machine-calls, web, attachments, icons, suits,
    //         preview, access; every owner "js"
  ];
  ```

- **Output shape**: `{ "messages": { "<type>": "<owner>", … }, "http": [ { "listener": …, "stage": …, "owner": … }, … ] }`,
  messages sorted by type, `http` in chain order.
- **Check**: fails when a schema gains a type the file lacks, the file names a type no schema has,
  an override names an unknown type, or two schemas define the same type.
- **Tests**: none new; the `--check` run is the check. **Bench**: none.
- **Must not**: hand-edit `routes.json`; import daemon internals beyond the schema packages and
  the owners file; mark anything `rust:`.
- **Reviewer checks**: a scratch literal added to `PluginClientMessage` or to an option of
  `UserBrowserExtensionMessage` makes `--check` fail; two runs give identical bytes.

#### T0.4 Baseline measurements (owner-scheduled, no builder)

A historical record only: the benches below, switch off, on the T0 merge commit, labelled
"historical (T0)". The ship decision never uses them: both legs of every paired run are taken on
the same T1a head commit (below).

### T1a: the loopback listener in Rust (switch `ACE_TRANSPORT=native`, default off)

What moves: accepting connections on the loopback port, HTTP/1.1 parsing, the WebSocket upgrade
handshake and framing. **What stays TypeScript in all of T1a**: every HTTP handler (reached through
a proxy hop, unchanged), upgrade admission decisions (path, Origin, the 256 cap, pre-auth budgets:
Rust asks TypeScript), hello and authentication, the outbox, frame packing, input backpressure
policy (it calls `pause`/`resume`), ace's JSON pings and the idle sweep, the close-grace closer, the
remote listeners, the relay. Rust implements the `MainSocket` interface
(`apps/daemon/src/main-socket.ts`) and nothing above it.

**Paired benches and the ship rule** (all T1a benches; one bench at a time on this Mac, scheduled
by the owner). Both legs run on the same T1a head commit and build. Each pair runs off then on,
back to back, three pairs, A B A B; a pair whose load
average differs by more than 2× between its two runs is discarded and rerun. T1a may go default-on
only if every median passes:

| Bench                                                                                      | Metric                                                                 | On must be                   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------- |
| `FANOUT_EVENTS=3000 FANOUT_ROUNDS=3 bun apps/daemon/bench/fanout.ts`                       | daemon CPU per event, 1/3/6 subs                                       | ≤ off × 1.10 at each count   |
| `node tools/daemon-bench/src/run.ts --output=<file>` (standard workload, no baseline gate) | `phases.*.cpuMsPerTurn`                                                | ≤ off × 1.10                 |
| same                                                                                       | `phases.*.transactionsPerTurn`                                         | within ±1% of off            |
| same                                                                                       | `idle.cpuPercent`                                                      | ≤ off + 0.2 points of a core |
| same                                                                                       | `startup.heapUsed`, `idle.memory.heapUsed`, `phases.*.memory.heapUsed` | ≤ off + 4 MiB                |
| same                                                                                       | `startup.rss`, `idle.memory.rss`, `phases.*.memory.rss`                | ≤ off + 16 MiB               |

The daemon bench's on leg runs with `ACE_TRANSPORT=native` and an absolute
`ACE_TRANSPORT_ADDON` (T0.1), and its daemon log must show the native listener started (T1a.8's
evidence file), or the pair is void. `bun run bench:daemon` compares against its stored baseline, not against the other leg, so it is
not the ship rule. If any median fails, T1a stays opt-in and ships with T3 (ADR 0226 §6).

#### T1a.1 TypeScript seams, no behaviour change (ready)

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
- **Invariants**: behaviour.md §2 and §3; `/v1/stop` proves its caller by the connection's ports
  (`shutdown-receipt.ts:36`, `peer-process.ts`), so those ports must be the client's real ones.
- **Tests (switch off; nothing is native yet)**: `socket-admission.server.process`,
  `auth.server.process`, `access-cors.server.process`, `daemon-lifecycle.process`,
  `daemon-stop-restart.process` (the real `ace stop`, which sends its caller chain,
  `cli/daemon-stop.ts:149`), each alone.
- **Bench**: none. **Must not**: change any decision, status code, order of checks or log line;
  add tests.
- **Reviewer checks**: the extracted function is the old body moved, not rewritten (compare hunk
  by hunk); the five files pass.

#### T1a.2 Rust: the connection driver, the HTTP listener and the proxy hop (a standalone milestone)

Compiles and is tested alone. An upgrade candidate goes to an `UpgradeHandler`; this task's only
implementation, `RefuseUpgrades`, closes the connection without an answer. T1a.3 replaces it.

- **Files**: create `native/daemon/crates/ace-transport/src/{driver.rs,head.rs,prefixed.rs,listener.rs,proxy.rs,hop.rs,peer.rs}`;
  change `lib.rs`, `error.rs`, `Cargo.toml`.
- **Crates** (versions as in the lock; `cargo deny check` on the resolved feature graph, not only
  the direct licences): `tokio` 1.54 (`net`, `rt-multi-thread`, `sync`, `macros`, `time`,
  `io-util`; MIT), `tokio-util` 0.7.20 (`CancellationToken`; MIT), `hyper` 1.12 (`server`,
  `client`, `http1`; MIT), `hyper-util` 0.1.21 (`tokio`; MIT), `http-body-util` 0.1.5 (MIT),
  `http` 1.5 (MIT OR Apache-2.0), `bytes` 1.12 (MIT), `httparse` 1 (MIT OR Apache-2.0; already
  hyper's), `getrandom` (MIT OR Apache-2.0, for the secret).
- **The connection driver** (`driver.rs`), one task per accepted `TcpStream`, which is how HTTP,
  upgrade candidates and silent drops are told apart:
  1. Read the first request head from the stream into a buffer (`head.rs`: `httparse` over at most
     16 KiB, Node's default `maxHeaderSize`, within the 60 s headers timeout). A head over 16 KiB
     gets `HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n` and the
     connection closes, as Node answers; a head that doesn't parse gets
     `HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n`, as Node does.
  2. It is an **upgrade candidate** when, as for Node's `upgrade` event, it carries an `Upgrade`
     header and `upgrade` among the `Connection` tokens. Then the driver keeps the **raw
     request-target** exactly as received (`httparse`'s `path`: `/`, `/?x`, `//` and absolute-form
     stay distinct) and hands the parsed head, the raw stream and any bytes read past the head to
     the `UpgradeHandler`, which owns the stream from then on: it writes the pinned response bytes
     itself, straight to the socket, or closes it with no bytes (the silent drop). hyper never
     sees an upgrade candidate that arrives first on a connection.
  3. Otherwise the driver gives hyper's `server::conn::http1` the stream wrapped in `prefixed.rs`'s
     `Prefixed<TcpStream>` (an `AsyncRead`/`AsyncWrite` that yields the bytes already read before
     reading the socket), with `keep_alive(true)` and Node's timeouts (keep-alive 5 s, headers
     60 s, request 300 s), and the service of `proxy.rs`. A later request on the same keep-alive
     connection that is an upgrade candidate is answered by the service with
     `HTTP 400` and `Connection: close` (browsers, `ws` and ace's native clients open a new
     connection per WebSocket; this is the one recorded difference from Node, which no test covers
     today, and T1a.8's new test pins it).
- **Types and signatures**:

  ```rust
  pub struct Peer { pub remote: SocketAddr, pub local: SocketAddr }      // from the accepted TcpStream only
  pub struct HopSecret([u8; 32]);                                         // OS CSPRNG (getrandom); no Debug, Display or Clone
  impl HopSecret { pub fn generate() -> Result<Self, TransportError>; pub fn from_hex(hex: &str) -> Result<Self, TransportError>; }
  pub struct ProxyTarget { pub addr: SocketAddr /* 127.0.0.1 only */, pub secret: Arc<HopSecret> }
  pub struct RequestHead { pub method: String, pub target: String /* raw */, pub headers: Vec<(String, Vec<u8>)> }
  pub trait UpgradeHandler: Send + Sync + 'static {
      fn upgrade(&self, head: RequestHead, stream: Prefixed<TcpStream>, peer: Peer, shutdown: CancellationToken)
          -> Pin<Box<dyn Future<Output = ()> + Send>>;
  }
  pub struct RefuseUpgrades;                                              // drops the stream
  pub struct LoopbackListener { /* local addr, CancellationToken, JoinSet of connection tasks */ }
  impl LoopbackListener {
      pub async fn bind(addr: SocketAddr /* 127.0.0.1 only */, target: ProxyTarget, upgrades: Arc<dyn UpgradeHandler>) -> Result<Self, TransportError>;
      pub fn local_addr(&self) -> SocketAddr;
      pub async fn close(self, deadline: Duration);
  }
  ```

- **The hop** (`hop.rs`, pure, unit-tested): four reserved headers and only these:
  `x-ace-hop-secret`, `x-ace-hop-peer-address`, `x-ace-hop-peer-port`, `x-ace-hop-local-port`.
  Every client-sent instance of them is removed; every other header passes as sent, including the
  `x-ace-*` headers clients use today (`x-ace-sha256` for uploads, `attachments-upload.ts:55`;
  `x-ace-json-input`; `x-ace-constraint`; the rest). Then exactly one value of each reserved header
  is added, from `HopSecret` (hex) and `Peer` (the accepted socket's remote IP, remote port and
  local port, decimal). Hop-by-hop headers (RFC 9110 §7.6.1: `Connection`, `Keep-Alive`,
  `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, and every header
  `Connection` names) are not forwarded in either direction; hyper frames each leg itself.
- **Forwarding** (`proxy.rs`): over a fresh `hyper::client::conn::http1` connection to `target`
  (127.0.0.1), method, raw target, headers and body streamed; the response streams back.
  **Cancellation**: a client that goes away mid-request or mid-response drops the upstream
  connection at once (the TypeScript handler sees its request abort, as today); an upstream
  failure mid-response resets the client connection, never ends a truncated body as complete.
  **Close**: stop accepting; close idle keep-alive connections at once; let in-flight requests and
  upgrade handshakes finish until `deadline`, cancelling `shutdown` for the handlers; then drop
  the rest.
- **Invariants**: behaviour.md §2 (`port: 0` picks a free port) and §3 (the chain's answers pass
  through byte for byte, CORS and `no-store` included).
- **Tests**: `#[cfg(test)]` unit tests for `head.rs` (raw target kept, candidate detection, 431 and
  400 bytes), `prefixed.rs` and `hop.rs`, and one in-crate test that proxies a request to a local
  hyper test server; new code, so allowed.
- **Must not**: answer an HTTP request itself beyond 400/431 above; hold a body whole (no
  `collect()`); log or format the secret; use `serde_json`; bind or connect anywhere but 127.0.0.1.
- **Reviewer checks**: a client-sent `x-ace-hop-secret` never reaches the target, `x-ace-sha256`
  does; an upgrade candidate never reaches hyper's service when first on a connection; clippy and
  deny pass.

#### T1a.3 Rust: the WebSocket handshake

- **Files**: create `native/daemon/crates/ace-transport/src/upgrade.rs`; change `lib.rs`,
  `Cargo.toml`.
- **Crates**: `tungstenite` 0.30 (MIT OR Apache-2.0; `handshake` for `derive_accept_key`).
- **Types**:

  ```rust
  pub struct UpgradeRequest { pub target: String /* raw */, pub origin: Option<String>, pub user_agent: Option<String>, pub peer: Peer }
  pub enum AdmissionDecision { Accept { reservation: u64 }, Forbidden, Unavailable, Drop }
  pub trait UpgradeAdmission: Send + Sync + 'static {
      /// Resolves once; the admission state machine (T1a.5) owns every release.
      fn admit(&self, request: UpgradeRequest) -> Pin<Box<dyn Future<Output = AdmissionOutcome> + Send>>;
      fn release(&self, reservation: u64);
  }
  pub enum AdmissionOutcome { Decided(AdmissionDecision), TimedOut }
  pub trait SocketSink: Send + Sync + 'static {
      fn opened(&self, reservation: u64, stream: Prefixed<TcpStream>, user_agent: Option<String>);
  }
  pub struct WebSocketUpgrades { admission: Arc<dyn UpgradeAdmission>, sink: Arc<dyn SocketSink> }  // implements UpgradeHandler
  ```

- **Order and bytes, pinned to today's** (Node fires `upgrade`, then `admitUpgrades`, then `ws`
  8.22's `handleUpgrade`), each written by the handler straight to the stream:
  1. admission on the raw target (`/` only; anything else, `/?x` included, is `Drop`, as
     `request.url !== "/"` is today, `socket-upgrade.ts:52`). `Drop` closes with no bytes;
     `Forbidden` and `Unavailable` (and `TimedOut`) write `refuseUpgrade`'s bytes exactly,
     `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n` or the same with
     `503 Service Unavailable` (`socket-upgrade.ts:6`–`:9`), then close;
  2. then `ws`'s checks, in its order, each failure written as `abortHandshake` writes it,
     `HTTP/1.1 <code> <reason>\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: <n>\r\n\r\n<message>`
     (plus `Sec-WebSocket-Version: 13, 8` for the version row), with the reservation released:
     method not `GET` → 405 `Invalid HTTP method`; `Upgrade` not `websocket` (case-insensitive) →
     400 `Invalid Upgrade header`; `Sec-WebSocket-Key` not matching `^[+/0-9A-Za-z]{22}==$` → 400
     `Missing or invalid Sec-WebSocket-Key header`; `Sec-WebSocket-Version` not 13 or 8 → 400
     `Missing or invalid Sec-WebSocket-Version header`; an unparsable `Sec-WebSocket-Protocol` →
     400 `Invalid Sec-WebSocket-Protocol header`;
  3. `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: <digest>\r\n`,
     plus `Sec-WebSocket-Protocol: <first offered>` when any was offered (`ws`'s default), then
     `\r\n`; no `Sec-WebSocket-Extensions` (no compression on loopback);
  4. then `SocketSink::opened` with the stream (and any bytes read past the head, which are the
     first WebSocket frames).
- **Tests**: unit tests for the decision table (inputs → exact bytes). **Must not**: start framing
  (T1a.4's), negotiate extensions.
- **Reviewer checks**: each row of step 2 compared with
  `node_modules/.bun/ws@8.22.0/node_modules/ws/lib/websocket-server.js` `handleUpgrade` and
  `abortHandshake`; the raw target is compared, not a parsed path.

#### T1a.4 Rust: the socket and its lifecycle

- **Files**: create `native/daemon/crates/ace-transport/src/socket.rs`; change `lib.rs`,
  `Cargo.toml`.
- **Crates**: `tokio-tungstenite` 0.30 (MIT; `default-features = false`: no TLS, no `connect`);
  `zeroize` 1 (Apache-2.0 OR MIT). `WebSocketStream::from_raw_socket(stream, Role::Server,
Some(config))` with `max_message_size = Some(1 << 20)` and `max_frame_size = Some(1 << 20)`.
- **Types**:

  ```rust
  pub enum SocketEvent {
      Message { data: Vec<u8> /* exclusively owned, writable */, binary: bool },
      Sent { id: u64, error: Option<String> },
      Error { code: &'static str, message: String },     // "too_big", "protocol", "io"
      Close { code: u16, reason: Vec<u8> },
  }
  pub enum SendResult { Queued, NotOpen }
  #[derive(Clone)] pub struct SocketHandle { /* Arc of shared state */ }
  impl SocketHandle {
      pub fn send(&self, data: Bytes, binary: bool, id: u64) -> SendResult;
      pub fn close(&self, code: Option<u16>, reason: String);
      pub fn terminate(&self);
      pub fn pause(&self); pub fn resume(&self); pub fn is_paused(&self) -> bool;
      pub fn buffered_amount(&self) -> u64; pub fn ready_state(&self) -> u8;
      pub fn delivered(&self, charge: u64);            // the JS side consumed one message
  }
  pub fn open(stream: Prefixed<TcpStream>) -> (SocketHandle, mpsc::UnboundedReceiver<SocketEvent>);
  ```

- **Invariants** (as `ws` behaves today, which the tests pin):
  - events in production order on one queue; `Close` is the last event, exactly once, on every exit
    path; after `Close`, nothing;
  - **`send` while the state is OPEN returns `Queued`, and that id gets exactly one `Sent` before
    `Close`**: after the frame is flushed to the kernel (`error: None`), or with an error when it
    can't be (closing, I/O failure, teardown), each failed with
    `"WebSocket is not open: readyState <n> (<NAME>)"` as `ws` words it. **`send` in any other
    state returns `NotOpen` and emits nothing**: the TypeScript wrapper takes the post-close path
    (T1a.6). The state check and the enqueue are one atomic step, so no send is both queued and
    refused;
  - `buffered_amount` counts bytes accepted by `send` and not yet flushed;
  - `pause` stops reading the socket (messages already read are still delivered); independently,
    the reader stops while the undelivered queue to JavaScript is at its bound: each message is
    charged its length plus 256 bytes (as `socket-input.ts`'s `messageOverhead`), and the reader
    waits while the charged total exceeds 1 MiB **or** 64 messages wait, so empty messages are
    bounded too; `delivered(charge)` releases a message's charge. The outbound queue is unbounded,
    as `ws`'s is, bounded by the TypeScript outbox through `buffered_amount`;
  - `ready_state` 1 → 2 → 3; `close` is idempotent and sends the close frame with its code and
    reason; `terminate` drops the connection and reports `Close` with `1006`;
  - an oversized message: `Error { code: "too_big" }`, then the close frame `1009`, then `Close`;
  - WebSocket **control** frames are the framing layer's: a peer's ping is answered with a pong and
    never surfaced, a pong is ignored, as `ws` does (`autoPong`); ace's JSON `{ "type": "ping" }`
    is an ordinary text `Message` for TypeScript to answer;
  - a peer's close is answered and reported with its code and reason (`1005` when none);
  - **zeroing**: each `Message` payload is copied out of tungstenite's message into a `Vec<u8>` the
    socket owns alone; the binding zeroes that vector (`zeroize`) after copying it into the
    JavaScript `Buffer` (T1a.5). tungstenite's own read buffer is reused and overwritten, not
    zeroed, as `ws`'s socket chunks aren't today: the wiped copies are the delivered ones, in both
    implementations.
- **Tests**: unit tests for the bookkeeping (send ids and results, ready state, buffered amount,
  the delivery bound including 64 empty messages) over an in-memory duplex. **Must not**: parse or
  answer any data message; block on a JavaScript call.
- **Reviewer checks**: no message parsing in `ace-transport`; one `Close` per exit path; no `Sent`
  after `Close`; `send` never returns `Queued` after `Close` was produced.

#### T1a.5 The binding

- **Files**: create `native/daemon/crates/ace-daemon-node/src/transport.rs`; change its `lib.rs`.
- **Exports** (napi 3, translating only, as `supervisor.rs` does with `ThreadsafeFunction`):

  ```ts
  class NativeLoopback {
    static generateSecret(): string; // 32 bytes from the OS CSPRNG, hex; once per boot
    static start(
      options: { port: number; targetPort: number; secretHex: string; admitTimeoutMs: number },
      admit: (request: {
        id: number;
        target: string;
        origin: string | null;
        address: string;
      }) => Promise<{
        decision: "accept" | "forbidden" | "unavailable" | "drop";
        reservation: number;
      }>,
      release: (reservation: number) => void,
      opened: (socket: NativeSocketHandle, reservation: number, userAgent: string | null) => void,
    ): Promise<NativeLoopback>;
    port(): number;
    close(deadlineMs: number): Promise<void>;
  }
  type NativeSocketEvent =
    | { kind: "message"; data: Buffer; binary: boolean; charge: number }
    | { kind: "sent"; id: number; error: string | null }
    | { kind: "error"; code: "too_big" | "protocol" | "io"; message: string }
    | { kind: "close"; code: number; reason: Buffer };
  class NativeSocketHandle {
    listen(events: (event: NativeSocketEvent) => void): void; // events queue until called
    send(data: Buffer, binary: boolean, id: number): boolean; // false: not open, nothing queued
    close(code: number | null, reason: string): void;
    terminate(): void;
    pause(): void;
    resume(): void;
    isPaused(): boolean;
    bufferedAmount(): number;
    readyState(): number;
  }
  ```

  The secret is never logged, written to disk, or published in the endpoint file or any discovery
  file; TypeScript keeps it in memory and passes it back to `start`.

- **Admission, one state machine per upgrade, in Rust** (an atomic state, every transition a
  compare-and-swap): `Pending` → `Accepted(reservation)` → `Opened` or `Released`; `Pending` →
  `Refused` (forbidden, unavailable, drop); `Pending` → `TimedOut` after `admitTimeoutMs` (5,000),
  which writes the 503 bytes and closes. **Who releases**: Rust, always, and at most once: a
  handshake failure or client disconnect after `Accepted` moves to `Released` and calls `release`;
  an acceptance that arrives after `TimedOut` (the JS promise resolved late) calls `release` for
  its reservation at once and nothing else; a shutdown (`close`) moves every `Pending` to
  `TimedOut` and every `Accepted` to `Released`. `opened` is called only on `Accepted → Opened`, so
  a timed-out, disconnected or shut-down upgrade never reaches `opened`, and no reservation is
  released twice. TypeScript's `release` is also idempotent (a reservation id it no longer holds is
  ignored).
- **Ordering and bytes**: one `ThreadsafeFunction` per socket carries all of its events in
  `SocketEvent` order. For a `message`, the binding copies the Rust vector into a new JavaScript
  `Buffer`, zeroes the vector (`zeroize`) and drops it, delivers the event, and calls
  `delivered(charge)` after the JS callback returns. TypeScript keeps today's wiping of its own
  `Buffer` (`socket-input.ts:64`–`:87`: queued text messages only, after handling; an immediate
  ping returns before the queue and is not wiped, as today).
- **Invariants**: panics become JS errors (napi's `catch_unwind`); the addon never waits
  synchronously on a tokio task.
- **Must not**: put any decision in the binding. **Reviewer checks**: conversions only; the state
  machine's transitions are the only place `release` and `opened` are called.

#### T1a.6 The TypeScript shell

- **Files**: create `packages/provider-kit/src/native-transport.ts` and add `"./native-transport"`
  to `packages/provider-kit/package.json` `exports`; create `apps/daemon/src/native-socket.ts`.
- **Loading is lazy**: `transportAddon()` loads the addon on its first call only (as
  `native-process.ts:99`–`:130`, with `ACE_TRANSPORT_ADDON`, else `ACE_STORE_ADDON`, else the
  development build) and is called only when `transportParts()` has `loopback`; importing the
  module never touches the binary, so the switch-off path runs without it. With the switch on and
  no addon, it throws naming the path, before any listener starts. When `ACE_TRANSPORT_EVIDENCE`
  names a file, each native listener start appends one JSON line to it (`{ "pid", "port",
"backend": "native" }`); nothing else reads that variable.
- **`class NativeSocket implements MainSocket`** over a `NativeSocketHandle`, with both `send`
  overloads as `ws` has them:
  - `send(data, callback?)` and `send(data, { binary?, compress? }, callback?)`; `binary` defaults
    to `typeof data !== "string"`, an explicit `binary` overrides it; `compress` is accepted and
    ignored (nothing is negotiated on loopback, as `ws` ignores it then);
  - **open path**: `handle.send(...)` returns `true`; the matching `sent` event runs the callback
    once (with an `Error` when `error` is set);
  - **post-close path**: when `readyState` isn't OPEN, or `handle.send` returns `false`, nothing is
    queued; the data's byte length is added to the wrapper's own post-close count that
    `bufferedAmount` adds to the handle's, and the callback, if any, runs on the next tick with
    `Error("WebSocket is not open: readyState <n> (<NAME>)")`, as `ws`'s `sendAfterClose` does.
    So a callback runs exactly once on either path, and never before its `send` returns;
  - `message` events become `("message", data, binary)`; `error` events an `Error` with `code`;
    `close` becomes `("close", code, reason)` after every open-path callback ran.
- **Tests**: none new. **Must not**: change `MainSocket`.
- **Reviewer checks**: no protocol logic in `native-socket.ts`; it type-checks against
  `MainSocket` with no casts; both overloads and the post-close path are covered by T1a.8's run.

#### T1a.7 Wiring

- **Files**: change `apps/daemon/src/server.ts`, `apps/daemon/src/server-http.ts`,
  `apps/daemon/src/socket-admission.ts`, `apps/daemon/src/machine-tunnel/wiring.ts`; create
  `apps/daemon/src/proxy-guard.ts`.
- **The guard** (`export function proxyGuard(secret: string, handler: Handler): Handler`, wrapping
  the `local` chain from `httpChains`), before dispatch, all of: the request's TCP peer is
  loopback (`127.0.0.1`, `::1` or `::ffff:127.0.0.1`); exactly one `x-ace-hop-secret`, equal to the
  secret in constant time (`timingSafeEqual` over equal-length buffers); exactly one valid value
  for each peer field (an IP address; ports integers 1–65535). Anything missing, malformed or
  duplicated: `403`, and the request never reaches the chain. Then it deletes the four hop headers,
  records `setPeer(request, …)` from them, and calls the chain, whose own authentication (bearer,
  org gate) runs unchanged.
- **One cap, counted in both places.** Today the 256-socket cap is checked twice: at the upgrade
  (`full: () => cleanups.size >= 256`, `server.ts:289`) and again in `connected`
  (`server.ts:393`), which relay arrivals reach too (`options.relayMain`, `:1196`–`:1205`). With
  native upgrades a reservation is held between the two: `PreAuthAdmission.reserve(kind,
address): number` takes a pre-auth slot and a socket slot when `admit` returns `accept`
  (`upgradeDecision` is evaluated with `full: () => cleanups.size + reserved >= 256`), so a burst
  can't pass against capacity already promised. `connected(socket, isLocal, request,
relayed?, reservation?)` checks `cleanups.size + reserved - (reservation === undefined ? 0 : 1) >= 256`
  (a relay arrival counts every reservation; a native open doesn't count its own), and in the same
  synchronous step turns the reservation into `preAuth.track(socket, …)` and the socket's cleanup
  entry: that is the moment a native open consumes its slot. `release` frees an unused
  reservation. The own-Origin check uses the **public** (native) port, not the internal server's
  (`ownLoopbackOrigin`, `socket-upgrade.ts:11`–`:24`).
- **Ports**: the internal server listens on `127.0.0.1:0` and is tracked with `tunnel.track`; the
  native port is held through a new `MachineTunnel.hold(port): () => void` (over
  `AcePorts.hold`, `wiring.ts:57`) from the moment it binds until it closes, so the tunnel treats
  both as ace's (ADR 0194).
- **Start and unwind**: internal server first, then `NativeLoopback.start` in the place of
  `bind(local, …)` (`server.ts:1227`). Both join the existing startup unwind (`server.ts:1267`–`:1283`):
  if anything later throws (the remote bind, `startTransports`, the remote runtime, preview), the
  unwind closes the native listener and then the internal server, where it closes `local` today.
  The URL and the endpoint file name the native port.
- **Shutdown**, in `server.ts`'s order (`:1330`–`:1370`): native sockets get
  `closer.gracefulClose(socket, 1001, "Daemon shutdown")` with the other sockets, before awaiting
  the listeners; `NativeLoopback.close(deadline)` then stops accepting (new upgrades are refused
  with the 503 bytes, as `ws` answers once closing, `websocket-server.js` `completeUpgrade`),
  moves pending admissions to `TimedOut` and accepted ones to `Released`, and drains; **a socket
  whose `opened` arrives after the first 1001 sweep** is given
  `closer.gracefulClose(socket, 1001, "Daemon shutdown")` as soon as `connected` registers it (the
  closing flag is checked there), with the same bounded terminate; the internal server closes after
  the native listener; `close()` resolves only after every native socket reported `close`.
- **Switch off**: no code path changes; every new branch is behind `transportParts()`.
- **Tests (wiring only, off then on)**: `socket-admission.server.process`, `auth.server.process`,
  `maintenance.server.process`, `socket-close-log.server.process`, each alone. **Must not**: touch
  the remote listeners, the relay or any handler; move the outbox, pings or input policy.
- **Reviewer checks**: the guard refuses each malformed case; every reservation is consumed or
  released exactly once; the shutdown order matches `server.ts`; the unwind closes native first.

#### T1a.8 The proof run

- **Files**: create `scripts/list-server-tests.ts` and
  `apps/daemon/src/native-loopback.process.test.ts`.
- **Discovery** (`list-server-tests.ts`): an import graph over `apps/daemon/src` and
  `packages/*/src`, relative imports resolved. The seed set is every non-test module that calls
  `startServer(`, `startDaemon(` or `startDaemonCli(`, or defines `fixture(` in
  `socket-test-support.ts`; then, repeated until nothing changes, every non-test module importing
  a module in the set joins it (so helpers of helpers count: `remote-test-support`,
  `engine/test-support`, `agent-control/daemon-test-support`, `daemon-launch-test-support`,
  `daemon-crash-test-support` and whatever imports them). It prints every `*.test.ts` that
  imports a module in the set or calls a seed function itself, sorted.
- **The new test** (allowed: no test covers these today; its header says so). Some assertions
  hold on both legs, some only where the native path exists; the native-only ones run under
  `it.runIf(transportParts().has("loopback"))` and the leg is proven by the evidence file:
  - **the guard, both legs**: `proxyGuard` is exported, so the test wraps a handler with a known
    secret on its own `node:http` server and checks that a request without the secret, with a wrong
    one, with a duplicated or malformed hop field, or from a non-loopback peer gets `403` and
    never reaches the handler, and that a valid one reaches it with the hop headers removed and
    `peerOf` set;
  - **the guard in the daemon, native leg only**: `startServer`'s result gains
    `internalHttpUrl?: string` (set only when the native loopback runs; never written to the
    endpoint file or any discovery file); a request straight to it without the secret gets `403`;
  - **caller ownership through the hop, both legs**: the test passes a `shutdown` option built
    with `shutdownControl(home, …)`, whose `verifyCaller` is the daemon's own verifier
    (`verifiedCaller` from `peer-process.ts`, as `owned-processes.ts:201` calls it) and whose
    `caller` callback records what it is given. That is the existing callback `request` calls with
    the chain `access-http.ts:204`–`:209` verified (`shutdown-receipt.ts:85`); the receipt itself
    stores no caller. A real child process posts `/v1/stop` to the **public** port with its own
    chain: the callback receives that chain. The same request from a child that also sends forged
    `x-ace-hop-*` ports still has its chain verified (the hop replaces them). A request whose
    caller hint names another process (the test's own pid, which doesn't hold that connection)
    yields an empty chain;
  - **socket behaviour, both legs**: a message over 1 MiB closes with `1009`; a peer that drops the
    TCP connection is reported as `1006`; `send` after close calls its callback once with an error,
    on the next tick, through both overloads; a binary `Buffer` sent without options arrives binary
    and a `Buffer` with `{ binary: false }` arrives as text; shutdown closes open sockets with
    `1001`; an upgrade to `/?x` gets no answer; a second request on a keep-alive connection that
    asks to upgrade gets `400` on the native leg (the recorded difference, T1a.2).
- **Run, both legs per file, one file at a time, with evidence**:

  ```sh
  node scripts/list-server-tests.ts > /tmp/t1a-files.txt
  while read -r f; do
    test -f "$f" || continue
    bun --bun x vitest run "$f" --maxWorkers=4 >/dev/null 2>&1; off=$?
    evidence=$(mktemp)
    ACE_TRANSPORT=native ACE_TRANSPORT_EVIDENCE="$evidence" \
      bun --bun x vitest run "$f" --maxWorkers=4 >/dev/null 2>&1; on=$?
    test -s "$evidence" && used=native || used=NONE
    echo "$off $on $used $f"; rm -f "$evidence"
  done < /tmp/t1a-files.txt
  ```

  Every file passes both legs, and every on leg reports `native`: a file whose on leg started no
  native listener proves nothing and is investigated (a server started outside the switch, or a
  scrubbed environment). `scripts/test-home-policy.ts` keeps the three variables (T0.1), and the
  launch helpers already pass the environment through (`daemon-launch-test-support.ts`
  `daemonEnv`, `:19`–`:37`). Files whose remote sockets matter (`remote*`, `relay*`,
  `tailscale-https`, `access-cors`, `ticket-allocation`) keep those on TypeScript in T1a and must
  still pass.

- **Bench**: the paired runs above, owner-scheduled.
- **Must not**: run the full suite or a bench on its own. **Reviewer checks**: the list includes
  `daemon-stop-restart.process` and the engine and agent-control harness users; the off/on/evidence
  table is in the PR; `native-loopback.process` fails on the native leg if the guard or the hop is
  removed.

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
   `default-features = false, features = ["ring", "std", "tls12", "logging"]`, and
   `tokio-rustls` 0.26.6 (MIT OR Apache-2.0) also with `default-features = false, features =
["ring", "tls12", "logging"]`, because its defaults enable `aws_lc_rs`; `ring` 0.17 (Apache-2.0
   AND ISC, allowed) selected explicitly as the process's crypto provider; `cargo tree -e features
-i aws-lc-rs` must print nothing and `cargo deny check` pass on the resolved graph. The key and
   certificate TypeScript already loads from `tls/` (`tls-identity.ts`) passed as PEM bytes, never
   regenerated (pin continuity); SNI with the Tailscale certificate.
3. **T1b.2 Per-connection state and peer identity** through the proxy hop (trusted keep-alive,
   Tailscale peer), with the remote chain unchanged.
4. **T1b.3 Per-message deflate** as the spike decided, with allowlisted outbound compression and the
   1 MiB post-inflate cap.
5. **T1b.4 Run-time toggling** (`remote-runtime.ts`, `remote-direct.ts`) of the native remote
   listeners, with `remoteStarted`'s semantics.

Proof of Rust TLS termination: the files that dial the daemon's remote listener with the real
client and its pinned fingerprint (`remote.server`, `remote-boundaries.server`,
`remote-runtime.server`, `remote-restart.server`, `remote-compression.server`,
`tailscale-https.server`, `remote-direct.process`, `remote-payloads.process`, `access-cors.server`,
`ticket-allocation.server`), off and on, with evidence; `tls-identity-node.process` and any other
file that runs its own Node TLS server prove nothing about Rust and are not on the list. Bench:
items 5 and 6 of "Measurements to schedule", direct path, paired as for T1a.

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
