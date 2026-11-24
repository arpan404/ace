# T1b: the remote listeners in Rust (switch `ACE_TRANSPORT=native,remote`, default off)

Part of the [transport porting guide](porting-guide.md); its rules, its "Who writes the code" and
its commands apply unchanged. T1a (T1a.1–T1a.7) is merged; T1b.0's report
([t1b0-deflate-spike.md](t1b0-deflate-spike.md)) decided compression: our own RFC 7692 extension
over `flate2`, on our own server framing, behind the `Sink`/`Stream` seam `tokio-tungstenite`
fills today. Read both before any task here, and ADR 0226 answer 1.

What moves: accepting TCP connections on the remote listeners, TLS termination (pinned identity and
the Tailscale certificate by SNI), HTTP/1.1 on those connections, the WebSocket upgrade and framing,
and per-message deflate. **What stays TypeScript in all of T1b**: every HTTP handler (reached
through the proxy hop, as on loopback), upgrade admission (Rust asks), hello and authentication,
the outbox and the compression allowlist (`compression-policy.ts`, `outbox.ts:246`, `:311`–`:329`),
TLS identity generation and loading (`tls-identity.ts`, `node-tls-identity.ts`: no `rcgen` in
T1b), the Tailscale certificate's fetching, parsing and refresh (`tailscale-certificate.ts`), and
every run-time decision of remote access (`remote-runtime.ts`, `remote-direct.ts`,
`remote-policy.ts`). Rust terminates bytes; TypeScript still decides.

## Today's two remote listeners (what is ported)

- **The static listener**, `options.remote` (`server.ts:272`–`:274`): a `node:https` server with
  one identity, `minVersion: "TLSv1.2"`, Node's defaults otherwise (`handshakeTimeout` 120 s,
  `keepAliveTimeout` 5 s, ALPN `http/1.1`), with `requestTimeout = 0` and `headersTimeout = 10_000`
  (`:275`–`:279`). Only test support builds it (`remote-test-support.ts:22`), and most of the proof
  files run through it, so it moves too.
- **The run-time listener**, built by `remoteDirect` (`remote-direct.ts:117`–`:170`) through
  `sniListener` (`sni-listener.ts`): a `node:tls` front ending TLS and handing each decrypted socket
  to an HTTP server that never listens (`:85`–`:110`), with its own limits (`:28`–`:33`: handshake
  10 s, first headers 10 s, keep-alive 5 s, trusted keep-alive 60 s), per-connection state (the
  in-flight count, the idle timer and the trusted flag, `:74`–`:81`, `:118`–`:182`), and an
  `SNICallback` choosing Tailscale's certificate for the ts.net name (`remote-direct.ts:133`–`:139`,
  `tailscale-certificate.ts:135`–`:138`). It is the one production uses (`ACE_LISTEN=lan` or
  Tailscale through `remoteConfig`), and `remote-runtime.ts` opens, moves and closes it at run time.
- **Both** share `remoteWss` (`server.ts:282`–`:286`: `maxPayload` 1 MiB, `remoteDeflate`) and
  `admitUpgrades(listener, false, …)` (`socket-upgrade.ts:74`–`:124`: no Origin check, the remote
  pre-auth budget, `remoteSockets` for `disconnect`).
- **Per-connection facts the handlers read**: the peer address and ports (`http-peer.ts`, through
  `peerOf`), the TLS server name (`external-mcp/server.ts:252`, `:290`: `socket.servername`), the
  tailnet peer for outside MCP limits (`:300`), and the trusted keep-alive (`keepTrusted`,
  `sni-listener.ts:44`–`:50`, called by `machines/http.ts:61` and `transfers/http.ts:61`).

## Decisions this brief makes

1. **The hop carries connection state; nothing else does.** Each forwarded request is a fresh hop
   connection (T1a.2), so per-connection state crosses as reserved hop headers: the request gains
   `x-ace-hop-servername`, the response may carry `x-ace-hop-trust`. Rust strips both from
   whatever a client or a handler sends in the wrong direction, as it strips the four T1a headers.
2. **Rust owns the connection's timers and its `Keep-Alive` answer.** `Keep-Alive` is hop-by-hop
   (T1a.2 never forwards it), so the remote listener writes `keep-alive: timeout=<N>` itself on every
   response, N from the connection's trusted flag after this response, exactly as
   `sni-listener.ts:96`–`:100` and `:49` do.
3. **Certificates cross as PEM bytes, once, and are never regenerated.** TypeScript loads `tls/`
   as today and passes the same `key.pem` and `cert.pem` bytes; Rust parses them with
   `rustls::pki_types::pem::PemObject`. The pinned fingerprint is TypeScript's, computed from the
   same `cert.pem` (`tls-identity.ts:6`–`:9`), so it can't drift. Tailscale's certificate is pushed
   to Rust whenever TypeScript's served one changes, and cleared when it expires.
4. **One provider, chosen per config.** `rustls::ServerConfig::builder_with_provider(ring)`, never
   `CryptoProvider::install_default` (a process-wide singleton, which AGENTS.md bans and which a
   second rustls user in the addon could set differently).
5. **One framing implementation for both listeners** (T1b.0 §4): loopback moves onto it too, with no
   extension negotiated, so the plain and compressed paths can't drift.
6. **`flate2` with the `zlib-rs` backend**, not miniz_oxide (this amends ADR 0226's table row):
   `ws` honours a client's `server_max_window_bits` by deflating with that window
   (`permessage-deflate.js:184`–`:199` echoes it), which needs `Compress::new_with_window_bits`,
   available only with a zlib backend. `zlib-rs` (Zlib) is already in the lock; no C toolchain.
7. **`compress` defaults to `true`**, as `ws` does (`websocket.js:485`–`:495`): a send with no
   options compresses when the extension is negotiated and the message reaches 1,024 bytes. Only
   `{ compress: false }` (the outbox's allowlist refusal) keeps a large message plain. Rust adds
   the threshold and nothing else.
8. **The static listener and the run-time listener are one Rust type**, `RemoteListener`,
   configured by `RemoteLimits`; the static one has no trusted keep-alive and no SNI certificate.

## Recorded differences (each goes into behaviour.md §2 or §3 in the task that makes it)

1. **TLS 1.2 cipher suites**: only ECDHE with AES-GCM or ChaCha20-Poly1305 (rustls' ring suites).
   The Node/Bun stack also accepts CBC and DHE suites; a client offering only those fails the
   handshake. Every ace client (browsers, iOS `URLSession`, Node and Bun) offers AEAD ECDHE.
2. **Key exchange groups**: X25519, P-256, P-384. Not P-521, and **no post-quantum hybrid**
   (`X25519MLKEM768`), which ring does not implement (aws-lc-rs does, and is excluded). A browser
   sends an X25519 share beside its hybrid one, so it negotiates X25519 in the same round trips; a
   client that offered only a hybrid share would get a HelloRetryRequest. See open question 1.
3. **Session resumption**: rustls' `ring::Ticketer` (in memory, ChaCha20-Poly1305, keys rotated
   every 6 h, valid about 12 h). Node's default session lifetime is 300 s, so a paired machine may
   resume where it would have made a full handshake. Restarting or re-opening the listener makes
   new keys, as today.
4. **SNI**: rustls lower-cases the name and drops one trailing dot before the resolver sees it, so
   `x-ace-hop-servername` arrives normalised where Node's `socket.servername` is as sent
   (`reach.ts:91` and `tailscale-certificate.ts:136` normalise anyway, so no decision changes). An IP
   literal in SNI is treated as no SNI (pinned certificate), as Node serves it. **An SNI that is
   not a valid DNS name fails the handshake** with `illegal_parameter`
   (`rustls/src/server/hs.rs:748`–`:754`), where Node serves the pinned certificate; no ace client
   sends one.
5. **TLS alerts and handshake failures** (garbage, plain HTTP to the TLS port, a stalled hello):
   both stacks close; the alert bytes, if any, may differ. Nothing in ace parses them.
6. **`Connection: keep-alive` is not written** on HTTP/1.1 responses (hyper leaves it implicit, RFC
   9112 §9.3); `keep-alive: timeout=N` is. Field names are hyper's lower case, as T1a's recorded
   difference already says for the proxy hop.
7. **TCP connection cap**: at most 1,024 TCP connections per remote listener
   (`DEFAULT_MAX_TCP_CONNECTIONS`, T1a.2); one over it is accepted and closed at once. Node has no
   cap. The WebSocket caps (256 sockets, 64 pre-auth remote, 16 per address) are unchanged.
8. **An upgrade that finishes while its listener retires is closed**: with Node, a socket whose
   `ws` upgrade straddles `remoteDirect`'s `disconnect()` and `close()` can survive the retire
   (`sni-listener.ts:172`–`:180` drops it from `owned`). Natively it is terminated (settings-only
   retire) or given `1001` (daemon shutdown) as soon as it is registered (T1b.4), which is what the
   retire means.
9. **`keepTrusted` after the response's headers were sent does nothing natively**: Node still marks
   the connection trusted for its idle timer (`:47`). Both callers call it before writing
   (reviewer check, T1b.2).
10. **Compressed bytes differ**: zlib-rs at level 6 and Node's zlib at level 6, memLevel 8, need not
    produce identical streams. Sizes stay within ±3% (the bench checks it); every inflater reads
    both. `ws`'s `concurrencyLimit: 10` has no counterpart: each socket's writer compresses its own
    messages in order on tokio.
11. **Extension parameter numbers**: window-bit values are decimal digits only. `ws` reads them
    with JavaScript's `+value`, so `0x0a`, `1e1`, `10.0` and `+10` pass there and are refused with
    `ws`'s 400 here. No client sends them.

## Order and dependencies

T1b.1 → T1b.2 → T1b.4, with T1b.3a beside T1b.1 (it touches only the socket) and T1b.3b after
T1b.1b and T1b.3a; T1b.5 last. Each part is one builder round and one branch
(`ace/rust-transport-t1b-<part>`). Until T1b.3b merges, the native remote path negotiates no
extension, so `remote-compression.server` is off every on-leg list before T1b.5.

**server.ts is at 1,499 lines** (the hard limit is 1,500). No T1b task may grow it: T1b.1b first
moves the native listeners' start, unwind and shutdown steps into a new module (below), as a pure
move, and every later change to `server.ts` is net zero or negative.

---

### T1b.1a Rust: TLS termination and the remote listener

- **Files**: create `native/daemon/crates/ace-transport/src/{conn_io.rs,limits.rs,accept.rs}`,
  `src/tls/{mod.rs,identity.rs,resolver.rs,config.rs,handshake.rs,tests.rs}` and
  `src/remote/{mod.rs,listener.rs,tests.rs}`; change `driver.rs`, `listener.rs`, `prefixed.rs`,
  `lib.rs`, `error.rs`, `Cargo.toml`, `native/daemon/Cargo.lock`. Every file under 400 lines.
- **Crates** (versions in the local registry on 2026-11-24; `cargo deny check bans licenses sources`
  on the resolved feature graph, not only the direct licences):
  - `rustls` 0.23.46 (Apache-2.0 OR ISC OR MIT),
    `default-features = false, features = ["ring", "std", "tls12", "logging"]`;
  - `tokio-rustls` 0.26.6 (MIT OR Apache-2.0),
    `default-features = false, features = ["ring", "tls12", "logging"]`, because its defaults
    enable `aws_lc_rs`;
  - **no direct `ring` dependency**: ring 0.17.14 (Apache-2.0 AND ISC, both allowed) is reached
    through `rustls::crypto::ring`; transitively `rustls-webpki` 0.103.17 (ISC), `rustls-pki-types`
    1.16.0 (MIT OR Apache-2.0, its `pem` module used through `rustls::pki_types`), `untrusted` 0.9.0
    (ISC), `subtle` 2.6.1 (BSD-3-Clause), `log` 0.4 (MIT OR Apache-2.0), `cc` at build time (MIT OR
    Apache-2.0). No `rustls-pemfile` (unmaintained; pki-types replaces it), no `rcgen`.
  - `cargo tree -e features -i aws-lc-rs --target all` must print nothing. ring compiles C and
    assembly with `cc`: the Windows VM build is part of this task's checks.
- **The stream seam** (`conn_io.rs`): `pub trait ConnIo: AsyncRead + AsyncWrite + Unpin + Send + 'static {}`
  for `TcpStream` and `tokio_rustls::server::TlsStream<TcpStream>`. `driver.rs` runs over
  `Prefixed<Box<dyn ConnIo>>` instead of `Prefixed<TcpStream>`; `UpgradeHandler::upgrade_raw` takes
  that type. Loopback passes a boxed `TcpStream`; nothing else in T1a's behaviour changes.
- **Limits** (`limits.rs`), replacing the driver's constants with data:

  ```rust
  pub struct ConnectionLimits {
      pub handshake: Option<Duration>,        // TLS only; None on loopback
      pub first_head: Duration,               // from accept (or handshake end) to the first head
      pub head: Duration,                     // a later head, from its first byte
      pub keep_alive: Duration,               // idle, no request in flight, not trusted
      pub trusted_keep_alive: Option<Duration>, // None: the trust marker is ignored (T1b.2)
      pub exchange: Option<Duration>,         // whole-exchange deadline; None = Node's requestTimeout 0
      pub upgrade_write: Duration,            // TimedIo's bound on a 101 or a refusal (5 s)
  }
  impl ConnectionLimits {
      pub fn loopback() -> Self;       // T1a's values, unchanged
      pub fn remote_static() -> Self;  // handshake 120 s, first_head 10 s, head 10 s, keep_alive 5 s, trusted None, exchange None
      pub fn remote_sni(l: SniLimits) -> Self; // handshake l.handshake, first_head/head l.headers, keep_alive, trusted Some(l.trusted_keep_alive), exchange None
  }
  ```

  `SniLimits { handshake, headers, keep_alive, trusted_keep_alive }` mirrors
  `sni-listener.ts:12`–`:26`, defaults `:28`–`:33`. **Write timeout**: on a remote connection
  `TimedIo` bounds only the `101` or refusal write (`upgrade_write`) and is disarmed
  (`TimedIo::set_timeout(None)`, new) before the stream reaches the socket or hyper's HTTP loop:
  Node bounds no HTTP or WebSocket write, and a slow 3G peer stalls longer than 5 s.

- **The accept loop** (`accept.rs`): T1a's loop moved out of `listener.rs` (accept, the TCP cap,
  `ACCEPT_RETRY`, the `JoinSet`, the close deadline) and made generic over a per-connection
  `async fn(TcpStream, Peer) -> Option<Box<dyn ConnIo>>` (loopback: box it; remote: the TLS
  handshake). `LoopbackListener` keeps its API.
- **Identity** (`tls/identity.rs`):

  ```rust
  pub struct TlsIdentity(Arc<CertifiedKey>);
  impl TlsIdentity {
      /// The chain (leaf first) and the key exactly as `tls/cert.pem` and `tls/key.pem` hold them.
      pub fn from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<Self, TransportError>;
  }
  ```

  `CertificateDer::pem_slice_iter` for the chain (at least one certificate, else
  `TransportError::Identity`), `PrivateKeyDer::from_pem_slice` for the key (PKCS#8, PKCS#1 or
  SEC1, which covers OpenSSL's and LibreSSL's `req -newkey rsa:2048` output, `node-tls-identity.ts`
  and Tailscale's ECDSA keys), `rustls::crypto::ring::sign::any_supported_type` (what the provider's
  `key_provider` uses), and `CertifiedKey::keys_match()` so a key that doesn't belong to the certificate
  is refused at load (`TransportError::Identity`, naming which part failed, never echoing bytes).
  The key PEM is copied into `Zeroizing<Vec<u8>>` and dropped after parsing. **Never generate,
  rewrite or re-encode an identity.**

- **SNI** (`tls/resolver.rs`), a `ResolvesServerCert`:

  ```rust
  pub struct SniResolver { pinned: Arc<CertifiedKey>, trusted: RwLock<Option<Trusted>> }
  struct Trusted { name: String /* lower case, no trailing dot */, key: Arc<CertifiedKey> }
  impl SniResolver {
      pub fn new(pinned: TlsIdentity) -> Self;
      pub fn set_trusted(&self, name: &str, identity: TlsIdentity); // replaces; new handshakes only
      pub fn clear_trusted(&self);
  }
  ```

  `resolve`: `hello.server_name()` equal (ASCII case-insensitive) to the trusted name → the trusted
  key; anything else, no SNI, or no trusted certificate → pinned, as
  `tailscale-certificate.ts:135`–`:138` and `remote-direct.ts:137`. Expiry is TypeScript's
  (T1b.4 clears at expiry with the injected clock); the resolver reads no clock. A connection keeps
  the certificate it shook hands with.

- **Config** (`tls/config.rs`): `builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))`,
  `.with_protocol_versions(&[&TLS13, &TLS12])` (Node's `minVersion: "TLSv1.2"`, max 1.3),
  `.with_no_client_auth()`, `.with_cert_resolver(resolver)`; `alpn_protocols = [b"http/1.1"]`
  (`sni-listener.ts:107`, and `node:https`'s default); `ticketer = rustls::crypto::ring::Ticketer::new()?`;
  `max_early_data_size = 0` (no 0-RTT, as Node); `ignore_client_order = false` (Node's
  `honorCipherOrder` default); no `key_log`, ever.
- **Handshake** (`tls/handshake.rs`): `TlsAcceptor::accept` under `limits.handshake`; a stall,
  failure or timeout drops the TCP stream (Node's `tlsClientError` → `destroy`,
  `sni-listener.ts:136`). It returns the stream and the negotiated server name (`Option<String>`,
  for T1b.2).
- **The listener** (`remote/listener.rs`):

  ```rust
  pub struct RemoteListener { /* local addr, resolver, CancellationToken, accept task */ }
  impl RemoteListener {
      pub async fn bind(addr: SocketAddr /* any: 0.0.0.0 for the LAN, the 100.x address on Tailscale */,
                        identity: TlsIdentity, limits: ConnectionLimits,
                        target: ProxyTarget /* 127.0.0.1 only, as T1a */,
                        upgrades: Arc<dyn UpgradeHandler>) -> Result<Self, TransportError>;
      pub fn local_addr(&self) -> SocketAddr;
      pub fn resolver(&self) -> &SniResolver;
      pub async fn close(self, deadline: Duration);
  }
  ```

  Bound with tokio's `TcpListener::bind` (`SO_REUSEADDR` on Unix, as libuv sets it, so the port can
  be bound again at once after a close; nothing extra on Windows, as libuv). `Peer` comes from the
  accepted `TcpStream` before the handshake. **Close**: stop accepting, drop every connection that
  is handshaking, idle or carrying an HTTP exchange, at once when `deadline` is zero (what
  `sniListener.close` does, `:191`–`:199`); an upgrade in `Writing` is never cancelled (T1a.5).

- **Tests** (`#[cfg(test)]`, new code): identity — RSA PKCS#8 and PKCS#1, ECDSA SEC1, a chain of two,
  a mismatched key, an empty PEM, a key with no certificate; resolver — exact name, upper case,
  trailing dot, other name, none, after clear, a replacement served to the next handshake while an
  open connection keeps the old one; handshake — TLS 1.2 and 1.3 accepted, 1.1 refused, ALPN
  `http/1.1` chosen, a client offering only `h2` refused, a stalled ClientHello dropped at the
  handshake limit (tokio paused clock), resumption with a ticket; the listener — a request through
  TLS reaches a local hyper target with `x-ace-hop-*` set from the real peer, a second bind of the
  port after close succeeds. The client in these tests is `tokio-rustls`'s `TlsConnector` with a
  custom verifier that checks the SPKI SHA-256 against the expected one, the way ace pins.
- **Must not**: call `install_default`; read the clock in the resolver; log or format key bytes;
  bind the hop target anywhere but 127.0.0.1; touch the binding or TypeScript.
- **Reviewer checks**: `cargo tree -e features -i aws-lc-rs --target all` prints nothing; deny
  passes; the release build and `cargo test -p ace-transport` pass on macOS, Linux and the Windows
  VM; T1a's crate tests pass unchanged.

### T1b.1b The binding, the TypeScript shell and the static listener

- **Files**: create `native/daemon/crates/ace-daemon-node/src/transport/remote.rs`; change
  `transport.rs` (the module list only); change `packages/provider-kit/src/native-transport.ts`;
  create `apps/daemon/src/native-remote.ts` and `apps/daemon/src/native-listeners.ts`; change
  `apps/daemon/src/native-upgrade.ts`, `apps/daemon/src/server.ts`.
- **Exports** (napi 3, translating only; `NativeRemote` reuses T1a's `Admission` state machine and
  its `Admitting`/`Sinking` bridges, `transport/admission.rs` and `transport/upgrade.rs`, one
  instance per listener, never a copy):

  ```ts
  class NativeRemote {
    /** Parses the PEM as `start` will, and throws naming what is unusable. Synchronous. */
    static checkIdentity(cert: Buffer, key: Buffer): void;
    static start(
      options: {
        host: string;
        port: number;
        targetPort: number;
        secretHex: string;
        admitTimeoutMs: number;
        cert: Buffer;
        key: Buffer;
        limits: {
          handshakeMs: number;
          headersMs: number;
          keepAliveMs: number;
          trustedKeepAliveMs: number | null;
        };
      },
      admit: NativeLoopbackAdmit, // T1a.5's three callbacks, same shapes
      release: (reservation: number) => void,
      opened: (socket: NativeSocketHandle, reservation: number, userAgent: string | null) => void,
    ): Promise<NativeRemote>; // resolves once bound; never waits on a certificate or the network
    port(): number;
    setTrusted(name: string, cert: Buffer, key: Buffer): void; // throws on unusable PEM
    clearTrusted(): void;
    close(deadlineMs: number): Promise<void>;
  }
  ```

  A bind failure rejects with an `Error` whose `code` is the OS's (`EADDRINUSE`,
  `EADDRNOTAVAIL`), as `bindListener`'s does, so `remoteDirect`'s catch (`remote-direct.ts:147`)
  reports the same words.

- **The shell** (`native-remote.ts`): `startNativeRemote(options): Promise<NativeRemoteListener>`
  where the options name the bind address, the identity (`{ key, cert }` Buffers from
  `loadIdentity`), the limits, the per-boot hop secret (the loopback's, T1a.7:
  `transport.remote` needs `transport.loopback`), the internal server's port, and a
  `NativeUpgrade` built with `kind: "remote"`. It appends the evidence line on start
  (`noteTransportStart(port, "remote")`; `noteTransportStart` gains a `listener` field,
  `"loopback"` or `"remote"`, in every line, T1a's included). It holds the public port with
  `tunnel.hold(port)` from bind to close (ADR 0194), and keeps the set of reservations admitted
  through this listener, releasing any still held when `close` resolves (never
  `preAuth.releaseAll()`, which would drop loopback's).
- **`native-upgrade.ts`** gains `kind: "local" | "remote"` in its wiring (data, not a mode flag:
  it is the `isLocal` input `upgradeDecision` already takes), and for `"remote"`: `wss` is
  `remoteWss`, `preAuth.reserve("remote", address)`, `upgradeDecision({ isLocal: false, … })` (no
  Origin check, `socket-upgrade.ts:58`–`:61`), the socket joins `remoteSockets` (whose type becomes
  `Set<MainSocket>`) and leaves it on close, as `:115`–`:119`, and `connection` is emitted with
  `isLocal` false.
- **The internal server**: `createServer(proxyGuard(secret, remoteHttp()))` on `127.0.0.1:0`, with
  `requestTimeout = 0` and `headersTimeout = 10_000` as the remote listener has today, its own
  `upgrade` destroying the socket (as T1a.7's local internal server), tracked with `tunnel.track`.
- **`native-listeners.ts`**: first, as a pure move, the native loopback's start, unwind and
  shutdown steps from `server.ts` (`:1300`–`:1321`, the unwind at `:1364`–`:1383`, the shutdown
  stages around `:1446`–`:1468`), then the static remote listener beside them: with `remote` on
  and `options.remote` set, the static `httpsServer` is not created; the internal remote server
  binds, then `startNativeRemote` with `ConnectionLimits::remote_static()`'s values, after the
  loopback and in the place of `bind(remote, …)` (`server.ts:1324`–`:1327`); `remoteOrigin` names
  its port. Unwind and shutdown keep `server.ts`'s order: remote sockets get `1001` with the other
  sockets, then the native remote listener closes (with the loopback's deadline), then its internal
  server.
- **Tests (off, then on with `ACE_TRANSPORT=native,remote`, each alone)**: `remote.server`,
  `remote-boundaries.server`, `access-cors.server`, `ticket-allocation.server`,
  `remote-payloads.process`. **Not yet**: `remote-compression.server` (T1b.3b).
- **Must not**: touch `remoteDirect`, `remoteRuntime` or `sni-listener.ts`; negotiate an
  extension; grow `server.ts`.
- **Reviewer checks**: the move into `native-listeners.ts` is hunk-for-hunk; `server.ts` is shorter;
  every reservation is consumed or released once per listener; `remote.server`'s "rejects a TLS
  fingerprint mismatch" and "persists … the private TLS identity across daemon restarts" pass on
  the on leg (pin continuity); the evidence file has a `"listener":"remote"` line.

### T1b.2 Per-connection state and peer identity through the hop

- **Files**: change `native/daemon/crates/ace-transport/src/{hop.rs,proxy.rs,driver.rs}`, create
  `src/conn_state.rs`; change `apps/daemon/src/{proxy-guard.ts,http-peer.ts,sni-listener.ts}` and
  `apps/daemon/src/external-mcp/server.ts`; create `apps/daemon/src/native-remote.process.test.ts`.
- **Connection state** (`conn_state.rs`), one per accepted connection, shared by its requests:
  `pub struct ConnState { servername: Option<String>, trusted: AtomicBool }`. The servername comes
  from the handshake (T1b.1a); `trusted` starts false and only ever goes true.
- **Hop, request direction** (`hop.rs`): a fifth reserved header, `x-ace-hop-servername`, added
  exactly once when the connection has a server name, never otherwise; every client-sent
  `x-ace-hop-servername` and `x-ace-hop-trust` is removed with the other reserved names.
- **Hop, response direction**: `x-ace-hop-trust` is reserved: Rust removes every instance from the
  response; if any was `1` and the listener has `trusted_keep_alive`, `trusted` becomes true before
  the head is written. Then Rust adds `keep-alive: timeout=<⌊limit/1000⌋>`, where limit is
  `trusted_keep_alive` when trusted, else `keep_alive` (`sni-listener.ts:96`–`:100`, `:49`). On the
  static listener (`trusted_keep_alive` None) the marker is dropped and the value is always 5.
- **Timers** (`driver.rs`): the first head within `first_head` of the handshake's end
  (`sni-listener.ts:152`); while any request is in flight no idle timer runs (`:155`–`:160`);
  when the last finishes, the connection closes after `trusted_keep_alive` if trusted, else
  `keep_alive` (`:161`–`:169`), dropped without `close_notify`, as `socket.destroy()`; an upgraded
  connection leaves every HTTP timer (`:172`–`:181`).
- **TypeScript**:
  - `proxy-guard.ts`: accepts at most one `x-ace-hop-servername`, valid only as 1–253 characters of
    `[a-z0-9.-]` (what rustls hands over); a second one or a malformed one is `403`, as the other
    fields. It removes it with the four.
  - `http-peer.ts`: `HttpPeer` gains `servername: string | null` and `viaHop: boolean`; the guard's
    `setPeer` sets `viaHop: true` and the servername; the fallback reads
    `socket instanceof TLSSocket && typeof socket.servername === "string" ? socket.servername : null`,
    which moves here from `external-mcp/server.ts`, so the switch-off path reads the same value.
  - `sni-listener.ts`'s `keepTrusted`: when `peerOf(request).viaHop`, set the response header
    `x-ace-hop-trust: 1` (if headers aren't sent) and return; otherwise today's body unchanged.
  - `external-mcp/server.ts`: `:252` and `:290` read `peerOf(request).servername`; `:300` sets the
    peer header from `peerOf(request).address`. Nothing else changes there.
- **Tests**: Rust unit tests for the new hop fields and the timers (paused clock: 5 s untrusted,
  60 s after a trusted answer, no timer while a request is in flight, the first-head limit).
  `native-remote.process.test.ts` is new, allowed because no test drives these through the daemon
  today (its header says so); every case runs on both legs unless named native-only
  (`it.runIf(transportParts().has("remote"))`), against a daemon with `remoteConfig` on the LAN at
  127.0.0.1 (as `tailscale-https.server`'s `tailnetDaemon`):
  - an unauthenticated answer says `timeout=5` and the connection closes about 5 s after it; an
    answer to an authenticated machine call says `timeout=60` and the connection is still open
    after 6 s;
  - a client-sent `x-ace-hop-trust`, `x-ace-hop-servername` or `x-ace-hop-peer-address` changes
    nothing a handler sees (native-only: the internal server's URL is reached only natively);
  - an outside MCP request at the ts.net name (Tailscale mocked as in `tailscale-https.server`)
    is served by the outside MCP chain, and the same request naming another host falls through to
    the daemon's routes;
  - a handler's `x-ace-hop-trust` never reaches the client.
  - then, off and on, each alone: `native-remote.process`, `remote.server`, `access-cors.server`,
    `tailscale-https.server`.
- **Must not**: forward `Keep-Alive` from the internal server; read the trust marker on loopback;
  change `keepTrusted`'s Node path.
- **Reviewer checks**: `machines/http.ts:61` and `transfers/http.ts:61` call `keepTrusted` before
  any write (difference 9 stays theoretical); the guard refuses a duplicated or malformed
  servername; `external-mcp/server.ts` no longer imports `TLSSocket`.

### T1b.3a Rust: our own WebSocket framing, both listeners

- **Files**: create `native/daemon/crates/ace-transport/src/frame/{mod.rs,header.rs,read.rs,write.rs,assemble.rs,tests.rs}`;
  change `src/socket/drive.rs`, `src/socket.rs`, `Cargo.toml`. `tokio-tungstenite` moves to
  `[dev-dependencies]` (the client in tests, so every socket test stays cross-implementation);
  `tungstenite` stays for `derive_accept_key` only.
- **What it is** (T1b.0 §5 item 3, written fresh from RFC 6455 §5): a server-side codec over the
  connection's `Box<dyn UpgradeIo>` exposing `Stream<Item = Result<Inbound, FrameError>>` and
  `Sink<Outbound>` where `Inbound { opcode, rsv1: bool, payload: Vec<u8> }` is a whole message
  (fragments assembled) or a control frame, and `Outbound { opcode, rsv1: bool, payload: Bytes }`.
  It replaces exactly what `WebSocketStream::from_raw_socket` did in `drive.rs:99`, `:125`–`:136`.
- **Rules, each with `ws`'s close code** (`receiver.js` 8.22 decides; T1a's socket tests pin most):
  client frames must be masked (else 1002); RSV2/RSV3 set → 1002; RSV1 on a data frame when no
  extension was negotiated → 1002, on a continuation frame always → 1002 (`receiver.js:232`–`:257`);
  reserved opcodes → 1002; a continuation with nothing to continue, or a new data frame inside a
  fragmented one → 1002; control frames over 125 bytes or not FIN → 1002; total payload of a
  message over 1 MiB → 1009 as soon as the header says so, before the payload is read; a 64-bit
  length with the top bit set → 1009; text not valid UTF-8 (whole message, after inflation) → 1007;
  a close frame of 1 byte → 1002, an invalid code (`ws`'s `isValidStatusCode`) → 1002, a reason not
  valid UTF-8 → 1007. Outbound: one unmasked FIN frame per message, 7/16/64-bit lengths, header and
  payload in one write, flushed per message (T1a.4's `Sent` after the flush).
- **Invariants**: T1a.4's, unchanged: one `Close` last, `Sent` once per queued id, the delivery
  bound, auto-pong, the zeroed delivered copies. `MAX_MESSAGE_BYTES` (`socket.rs:36`) is the limit.
  One read buffer per connection, reused; no allocation per message beyond the message.
- **Tests**: `frame/tests.rs` for the rules table (new code). T1a's `socket/tests.rs`,
  `socket/tests/close.rs`, `upgrade/tests.rs` and `listener/tests.rs` pass **unchanged**. Then the
  T1a.8 list on loopback, on leg only (`ACE_TRANSPORT=native`), with `scripts/t1a-proof.ts`: every
  file `native` and passing.
- **Bench**: the T1a pairs (`fanout.ts`, the daemon bench), loopback, T1a's thresholds, against
  this branch's head built without the task (owner-scheduled).
- **Must not**: negotiate or inflate anything (T1b.3b); send fragmented frames; parse a message.
- **Reviewer checks**: each rule's row compared with `ws/lib/receiver.js`;
  `cargo tree -p ace-transport -e normal` shows no `tokio-tungstenite`.

### T1b.3b Per-message deflate on the remote listeners

- **Files**: create `native/daemon/crates/ace-transport/src/deflate/{mod.rs,negotiate.rs,codec.rs,tests.rs}`;
  change `src/upgrade.rs`, `src/upgrade/handshake.rs`, `src/socket/drive.rs`, `src/socket/handle.rs`,
  `Cargo.toml`; change `ace-daemon-node/src/transport/socket.rs`; change
  `packages/provider-kit/src/native-transport.ts`, `apps/daemon/src/native-socket.ts`.
- **Crates**: `flate2` 1.1.11 (MIT OR Apache-2.0), `default-features = false, features = ["zlib-rs"]`;
  `zlib-rs` 0.6.8 (Zlib), both already in the lock. Check `cargo tree -e features -i flate2 --target all`:
  `procfs` (Linux) asks for flate2's defaults, so features unify; with `any_zlib` on, flate2 uses
  zlib-rs for every user. That is fine and expected.
- **Negotiation** (`negotiate.rs`, pure; remote listeners only — loopback never negotiates, as
  `server.ts:280` has no `perMessageDeflate`). Written fresh from RFC 7692 §5 and RFC 6455 §9.1's
  grammar; `ws` 8.22 decides only what is accepted and refused:
  - several `Sec-WebSocket-Extensions` lines are one list, joined with `, ` in order (Node's join);
  - the header is parsed into offers; a syntax error, an offer parameter that is unknown, repeated,
    or has a bad value (`server_max_window_bits` not 8–15; `client_max_window_bits` without a value
    or 8–15; `*_no_context_takeover` with a value), **in any `permessage-deflate` offer**, refuses
    the upgrade with `ws`'s `400` and body `Invalid or unacceptable Sec-WebSocket-Extensions header`
    (`websocket-server.js:308`–`:320`, `permessage-deflate.js:246`–`:292`). This is a new row after
    T1a.3 step 2's protocol row, same bytes form, reservation released. **The T1b.0 report said
    "negotiate nothing" here; that is not what `ws` does, and this brief corrects it.**
  - other extensions are ignored; the first `permessage-deflate` offer is accepted (with ace's
    options every offer passes `acceptAsServer`'s filter, `:161`–`:178`);
  - the answer is that offer's own parameters in their order, `client_max_window_bits` without a
    value removed, then `server_no_context_takeover` and `client_no_context_takeover` appended if
    absent, formatted `permessage-deflate; a; b=v` (`extension.js:179`–`:201`). Example: a browser's
    `permessage-deflate; client_max_window_bits` → `permessage-deflate; server_no_context_takeover; client_no_context_takeover`.
  - the expected column of the negotiation table is produced once by running `ws` 8.22's own
    `extension.parse` and `PerMessageDeflate.accept` on each input in a scratch script, and pasted.
- **The `101`**: `Sec-WebSocket-Extensions: <answer>\r\n` after `Sec-WebSocket-Protocol`, on the raw
  and the hyper path (`websocket-server.js:413`–`:419`).
- **Codec** (`codec.rs`): raw deflate (`Compress::new_with_window_bits(Compression::new(6), false, server_max_window_bits.unwrap_or(15))`),
  `FlushCompress::Sync`, the trailing `00 00 ff ff` removed; inflate
  (`Decompress::new_with_window_bits(false, client_max_window_bits.unwrap_or(15))`) of each frame's
  payload as it arrives, the trailer appended after the final fragment, output counted per chunk:
  **the byte that takes the message past 1 MiB fails it with `MessageTooLong` → 1009, during the
  loop** (exactly 1 MiB passes); a corrupt stream → 1007 (`permessage-deflate.js:528`). Both
  contexts reset after every message (no context takeover, both ways, always).
- **Send path**: `NativeSocketHandle.send(data, binary, compress, id)`; Rust compresses iff the
  extension was negotiated, `compress` is true and the payload is at least 1,024 bytes
  (`sender.js:372`–`:385`), setting RSV1. The shell passes `options.compress ?? true` (decision
  7); loopback ignores it as today. The gate is the handshake, not the policy: an un-negotiated
  socket never sets RSV1 (T1b.0 §3's trap).
- **Tests**: `deflate/tests.rs` — the negotiation table (browser offer, `client_max_window_bits`
  with and without a value, `server_max_window_bits=10`, two offers, a malformed header, an unknown
  parameter, a repeated one, no offer, only another extension); the three 1 MiB boundaries; a
  fragmented compressed message; a corrupt stream; RSV1 on a continuation; a socket that never
  negotiated receiving uncompressed bulk; compression with window bits 10 read back by an inflater
  limited to 10. Then, off and on, each alone: `remote-compression.server`, `remote-payloads.process`,
  `remote.server`, and T1a.8's list on loopback (on leg).
- **Must not**: decide to compress anything in Rust beyond the threshold; compress control frames;
  negotiate on loopback.
- **Reviewer checks**: the negotiation table's expected values come from running `ws`; the
  inflate cap aborts mid-stream (a 2 KiB frame inflating to 2 MiB allocates under 1.1 MiB).

### T1b.4 Run-time toggling of the native remote listeners

- **Files**: change `apps/daemon/src/{remote-direct.ts,remote-runtime.ts,sni-listener.ts,tailscale-certificate.ts,native-remote.ts,native-listeners.ts}`;
  create `apps/daemon/src/native-sni-listener.ts`.
- **The seam that already exists**: `remoteDirect`'s `listener` factory
  (`remote-direct.ts:35`–`:38`). `remoteRuntime` gains an optional `listener` it passes through;
  with `remote` on, `native-listeners.ts` hands it `nativeSniListeners(deps)`'s `make`, and
  `attach` for a native listener's internal server only tracks it and destroys its upgrades.
- **`native-sni-listener.ts`**: `nativeSniListeners(deps): { make(options: SniListenerOptions): SniListener; close(): Promise<void> }`.
  `make` reads `options.tls.key` and `options.tls.cert` (the pinned identity; `SNICallback` is
  ignored), calls `NativeRemote.checkIdentity` **synchronously** so an unusable identity throws from
  `makeListener` as `createServer` does today (`remote-direct.ts:133`), and returns an object whose
  `http` is the internal remote server (one per `remoteRuntime`, created on the first `make`, closed
  by `close()` after `direct.close()`), `listen(host, port)` = `startNativeRemote` with
  `remote_sni(options.limits)`, and `close()` = the native close with deadline 0, idempotent, and
  waiting for a start still in flight before closing what it bound.
- **Certificates**: `SniListener` gains optional `trust?(certificate: TrustedCertificate | undefined): void`
  (Node's `sniListener` doesn't implement it: its `SNICallback` reads `trusted` lazily);
  `remoteDirect` calls `listener?.trust?.(trusted)` after it replaces `trusted`
  (`remote-direct.ts:117`–`:128`) and after it makes a listener. `TrustedCertificate` gains
  `served(): TailscalePem | undefined` (the PEM it serves while `active()`) and
  `onServed(listener: () => void): () => void`, fired after a fetch installs a new certificate
  (`:115`–`:119`) and on `stop`. The native listener's `trust` subscribes and syncs: `served()` →
  `setTrusted(name, cert, key)`, or `clearTrusted()`; then it arms the injected `delay` for
  `min(expires - now(), 2_147_483_647)` ms (a timer can't hold more; a 90-day certificate re-arms) to
  sync again, so the certificate leaves Rust when TypeScript stops calling it active. A
  `setTrusted` that throws is logged and leaves the pinned certificate served.
- **Retire and re-open** (`takeDown`, `remote-direct.ts:65`–`:77`): `disconnect()` terminates
  `remoteSockets` (native ones included), then the listener closes with deadline 0, dropping every
  connection but an upgrade in `Writing`; such a socket's `opened` arrives later and the wiring
  terminates it (settings-only retire) or gives it `closer.gracefulClose(socket, 1001, "Daemon shutdown")`
  (daemon closing), matching the `disconnect` callback (`server.ts:1332`–`:1347`; recorded
  difference 8). A move to a new address is a close then a fresh `start` on the same port, which
  `SO_REUSEADDR` allows on Unix.
- **`remoteStarted`'s semantics, unchanged**: `directStarted` settles when the first commit's
  `listen` resolved or failed (`remote-runtime.ts:203`–`:214`), and `listen` resolves on bind, not
  on the certificate; both promises settle on close and never reject; listening never waits for
  remote access (behaviour.md §2).
- **Tests (off, then on, each alone)**: `remote-runtime.server`, `tailscale-https.server`,
  `native-remote.process`, `remote-restart.server` (Windows only: counted on the VM run).
  `remote-direct.process`, `sni-listener.process`, `sni-keep-alive.process`,
  `sni-keep-alive-on-node.process`, `tailscale-https.server`'s two tests that build their own
  `sniListener` (`:285`, `:326`) and `tls-identity-node.process` build the Node listener or a Node
  TLS server themselves: they pass on both legs and **prove nothing about Rust**; they are not the
  proof. `native-remote.process` gains, native-only: a renewed Tailscale certificate is served to a
  new connection while an open one keeps the old; an expired one is replaced by the pin; an upgrade
  in flight during a settings retire never leaves an open socket.
- **Must not**: move any decision of `remote-runtime.ts` or `remote-direct.ts` into Rust; make
  `listen` wait on the network; read `Date.now()` in the shell.
- **Reviewer checks**: with the switch off, `remote-direct.ts` and `remote-runtime.ts` behave
  identically (the new calls are optional-chained no-ops on Node's listener); no timer over
  2³¹−1 ms; the internal remote server closes after the last native remote listener.

### T1b.5 The proof run and the bench

- **Files**: change `scripts/t1a-proof.ts` (gains `--switch=<value>` and `--remote-evidence=<files>`;
  defaults keep T1a's run; no second script) and `tools/perf-kit/src/isolated-daemon.ts` (passes
  `ACE_TRANSPORT`, `ACE_TRANSPORT_ADDON` and `ACE_TRANSPORT_EVIDENCE` from the bench's own
  environment into the daemon, refusing a set switch whose addon path is unset, relative or names
  no file, as T0.1's `daemonEnv` does).
- **Run**: `node scripts/t1a-proof.ts --switch=native,remote` over T1a.8's whole list (discovery
  unchanged), off leg with the three variables removed, on leg with `ACE_TRANSPORT=native,remote`.
  T1a.8's labels and exit rules apply, and these files' on legs must also show a
  `"listener":"remote"` evidence line, or they are `NONE`: `remote.server`,
  `remote-boundaries.server`, `remote-runtime.server`, `remote-compression.server`,
  `tailscale-https.server`, `remote-payloads.process`, `access-cors.server`,
  `ticket-allocation.server`, `native-remote.process` (and `remote-restart.server` on Windows).
  macOS, Linux and the Windows VM.
- **Cross-mode (rollback)**: a daemon started on, stopped, and started off on the same home (and
  the reverse) serves the same fingerprint, keeps paired devices, and a paired device reconnects
  after minting a fresh ticket (tickets live in memory either way). Rust writes nothing to disk, so
  nothing is migrated. `remote.server`'s restart cases, run once with `ACE_TRANSPORT` changed
  between the two starts, are this check.
- **Bench pairing** (owner-scheduled, one at a time, both legs on the T1b head build, A B A B, three
  pairs, a pair void when load differs by more than 2× or the on leg's evidence lacks a remote line):

  | Bench                                                                                      | Metric                                                             | On must be                             |
  | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------- |
  | `bun apps/daemon/bench/head-of-line.ts --paths=direct --profiles=3g-slow,3g-fast --runs=3` | `stopAck` and `sendReceipt` medians, idle and under each bulk kind | ≤ off × 1.10                           |
  | same                                                                                       | event-loop gaps (p99)                                              | ≤ off × 1.10                           |
  | same                                                                                       | bytes delivered ahead of each urgent message, per bulk kind        | within ±3% of off (compression parity) |
  | `bun run --filter @ace/daemon bench:slow-link` (direct legs)                               | each reported latency median; bytes per scenario                   | ≤ off × 1.10; bytes ±3%                |
  | `node tools/daemon-bench/src/run.ts --output=<file>` with `ACE_LISTEN=lan`                 | T1a's rows (`cpuMsPerTurn`, idle CPU, heap, RSS)                   | T1a's thresholds                       |

  The relay benches (`relay-connect`, `relay-resume`) don't touch these listeners and are T6's. If
  any median fails, T1b stays opt-in, as T1a.

- **Owed by the owner, not a builder** (ADR 0226 answer 1): the ace web app over the ts.net name in
  a real browser with the switch on, and the iPhone client paired over the LAN, each opening a
  thread with a long transcript; and, if scheduled, the Autobahn fuzzing client against the framing
  (T1b.0 §4).

## Failure modes on restart and reconnect (AGENTS.md priority 2)

| Event                                                     | What happens, both legs                                                                                                                           | Where it is held                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Daemon restart, same home                                 | `tls/` is read, never regenerated; same fingerprint; links issued before pair once after (`remote.server`)                                        | T1b.1a identity, T1b.1b           |
| Restart switching backend either way                      | the same, plus tickets voided (in memory) and re-minted by device tokens                                                                          | T1b.5 cross-mode                  |
| Remote port still in `TIME_WAIT` after a stop             | binds again (`SO_REUSEADDR` on Unix, as libuv)                                                                                                    | T1b.1a test                       |
| Port taken by another program                             | `listen` rejects with the OS code; status says "Couldn't listen on port …"; loopback and relays keep serving                                      | T1b.1b; `remote-runtime.server`   |
| Unusable identity or Tailscale key                        | identity: `make` throws as `createServer` does; Tailscale: logged, pin served                                                                     | T1b.4                             |
| Settings retire, move to a new address, Tailscale on/off  | sockets terminated, listener closed at once, a late `opened` closed, reservations of that listener released, pending links withdrawn as today     | T1b.4                             |
| Stop while a bind or a certificate fetch is under way     | the bind that lands closes (`remote-direct.ts:157`–`:163`); the fetch is abandoned; shutdown never waits on the network                           | T1b.4 shell close waits the start |
| Reconnect storm after restart (every device at once)      | TLS handshakes on tokio, not the pump; pre-auth budgets (64 remote, 16 per address) and the 256 cap unchanged; 1,024 TCP connections per listener | T1b.1a; recorded difference 7     |
| Certificate renewed or expired while connections are open | open connections keep theirs; new handshakes get the new one, or the pin after expiry                                                             | T1b.4                             |
| A panic in a connection task                              | that connection drops; the listener keeps accepting; a panic in an export becomes a JS error (`catch_unwind`)                                     | T1b.1a, T1b.1b                    |
| Daemon crash                                              | the listener dies with the process; nothing on disk to repair                                                                                     | —                                 |

## Open questions for the owner

1. **Post-quantum key exchange.** ring has no `X25519MLKEM768`; aws-lc-rs has it and is excluded by
   this guide's rules. Accept recorded difference 2 (my recommendation: browsers fall back to X25519
   in the same round trips, and the pin, not the key exchange, is what protects the LAN path), or
   allow aws-lc-rs for the remote listeners later?
2. **Sends without options compress today.** `ws` compresses any message of at least 1 KiB unless
   told `compress: false`, so messages outside `compression-policy.ts`'s allowlist that skip the
   outbox (hello replies, errors) are compressed when large. T1b keeps that for parity. Should a
   later TypeScript change pass `compress: false` for them, as the policy's comment intends?
3. **Autobahn** as the framing's release gate needs Docker on one machine: schedule it, or rely on
   the cross-implementation tests and the T1a.8 list?
