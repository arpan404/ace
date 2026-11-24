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
   `x-ace-hop-servername`, the response may carry `x-ace-hop-trust`. Both join T1a's one reserved
   list on both sides (`hop.rs:21`–`:22`'s `RESERVED`, `proxy-guard.ts:9`–`:15`'s `HOP_HEADERS`,
   which `withoutHopHeaders`, `:84`–`:85`, removes), so every copy a client sends is stripped in
   Rust and refused or removed in TypeScript (T1b.2).
2. **Rust owns the connection's timers and its `Keep-Alive` answer.** `Keep-Alive` is hop-by-hop
   (T1a.2 never forwards it), so the remote listener writes `keep-alive: timeout=<N>` itself on every
   response, N from the connection's trusted flag after this response, exactly as
   `sni-listener.ts:96`–`:100` and `:49` do.
3. **Certificates cross as PEM bytes, once, and are never regenerated.** TypeScript loads `tls/`
   as today and passes the same `key.pem` and `cert.pem` bytes; Rust parses them with
   `rustls::pki_types::pem::PemObject`. The pinned fingerprint is TypeScript's, computed from the
   same `cert.pem` (`tls-identity.ts:6`–`:9`), so it can't drift. Tailscale's certificate is pushed
   to Rust whenever TypeScript's served one changes, and cleared when it expires.
4. **aws-lc-rs with post-quantum preferred, installed as the process provider** (the owner,
   2026-11-24). `X25519MLKEM768` is negotiated today between Node 26.7 and Bun 1.4.4 and between
   Node and Node, and Chromium 131+ and iOS 26's `URLSession` offer it by default; ring has no
   ML-KEM, so a ring-only listener would downgrade every one of those connections to classical
   key exchange. rustls' `aws_lc_rs` and `prefer-post-quantum` features put `X25519MLKEM768` first
   in `DEFAULT_KX_GROUPS` (`rustls/src/crypto/aws_lc_rs/mod.rs:254`–`:275`). The provider is
   installed once, in the binding's I/O shell (`CryptoProvider::install_default`, the only
   process-wide value T1b sets, set where AGENTS.md allows such things: at the boundary, not in
   logic); logic code builds its config from the provider it is handed, so tests pass their own.
   This replaces the ring-only rule of the earlier T1b section and amends ADR 0226's TLS row.
5. **One framing implementation for both listeners** (T1b.0 §4): loopback moves onto it too, with no
   extension negotiated, so the plain and compressed paths can't drift.
6. **`flate2` with the `zlib-rs` backend**, not miniz_oxide (this amends ADR 0226's table row):
   `ws` honours a client's `server_max_window_bits` by deflating with that window
   (`permessage-deflate.js:184`–`:199` echoes it), which needs `Compress::new_with_window_bits`,
   available only with a zlib backend. `zlib-rs` (Zlib) is already in the lock; no C toolchain.
   flate2's window constructors **panic outside 9–15** (`flate2-1.1.11/src/mem.rs:218`–`:228`,
   `:421`–`:428`), and `ws` accepts 8 in both directions, so 8 never reaches them: T1b.3b maps it
   as Node's zlib does (below), and a constructor is only ever called with 9–15.
7. **`compress` defaults to `true`** (the owner, 2026-11-24: kept for parity), as `ws` does (`websocket.js:485`–`:495`): a send with no
   options compresses when the extension is negotiated and the message reaches 1,024 bytes. Only
   `{ compress: false }` (the outbox's allowlist refusal) keeps a large message plain. Rust adds
   the threshold and nothing else.
8. **The static listener and the run-time listener are one Rust type**, `RemoteListener`,
   configured by `RemoteLimits`; the static one has no trusted keep-alive and no SNI certificate.

## Recorded differences (each goes into behaviour.md §2 or §3 in the task that makes it)

1. **TLS 1.2 cipher suites**: only ECDHE with AES-GCM or ChaCha20-Poly1305 (rustls' aws-lc-rs
   suites). The Node/Bun stack also accepts CBC and DHE suites; a client offering only those fails
   the handshake. Every ace client (browsers, iOS `URLSession`, Node and Bun) offers AEAD ECDHE.
2. **Key exchange groups follow the client's order.** rustls 0.23 keeps the provider's groups
   (`X25519MLKEM768`, X25519, P-256, P-384), but picks the first one the *client* lists, not the
   server's first (`rustls-0.23.46/src/server/hs.rs:557`–`:560`, `:645`–`:651`), and has no option
   to prefer the server's; its only use of the server order is the default key share. Node/OpenSSL
   picks the hybrid even for a client that lists X25519 first (the owner's 2026-11-24 probe), so
   the same client gets classical TLS here and hybrid TLS there. Every ace client names the hybrid
   first, probed with a raw `ClientHello` capture on 2026-11-24:
   - Chromium 158 (Electron 44's engine; BoringSSL has led with it since Chrome 131):
     `GREASE, X25519MLKEM768, X25519, P-256, P-384`, key shares `GREASE, X25519MLKEM768, X25519`;
   - Apple `URLSession` on macOS 27 (the iOS 26 stack): `GREASE, X25519MLKEM768, X25519, P-256,
     P-384, P-521`, key shares `GREASE, X25519MLKEM768, X25519`;
   - Node 26.8.1: `X25519MLKEM768, X25519, P-256, X448, P-384, P-521, ffdhe2048, ffdhe3072`, key
     shares `X25519MLKEM768, X25519`;
   - Bun 1.4.4: `X25519MLKEM768, X25519, P-256, P-384`, key shares `X25519MLKEM768, X25519`.
   rustls ignores the GREASE entries, so none of them gets classical. Not offered at all: X448,
   P-521 and the finite-field groups OpenSSL also lists; a client offering only those fails the
   handshake (no ace client does).
3. **Session resumption**: rustls' `aws_lc_rs::Ticketer` (in memory, keys rotated every 6 h,
   valid about 12 h). Node's default session lifetime is 300 s, so a paired machine may
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
12. **Errors after bind are logged in bursts, not one per event.** `sniListener` hands every
    `error` the TLS server emits after it bound to `log` (`sni-listener.ts:185`–`:188`), and an
    accept failure such as `EMFILE` repeats while it lasts. The Rust accept loop retries every 10 ms
    (`ACCEPT_RETRY`), so the binding reports the first failure of each OS error code per listener
    at once, then at most one line a minute per code with the count since, through the same `log`.
13. **Window bits 8 is served as 9**, and the answer still echoes `=8`, as `ws` does. Node 26's
    raw deflate writes the same bytes at 8 as at 9; ours is compatible with an 8-bit window for a
    different reason: zlib-rs 0.6.8 at level 6 with a 9-bit window never emits a match distance
    over 250 (512 minus its 262-byte lookahead), inside the 256 bytes RFC 7692 §7.2.1 lets a client
    with `server_max_window_bits=8` rely on. The bytes need not equal Node's, and no test says they
    do; T1b.3b's tests decode our output with a decoder that refuses any distance over 256. Inflate
    always uses a 15-bit window, which reads every stream a smaller window can produce and accepts
    what Node's raw inflater accepts at 8 (it does not refuse a distance beyond 256 within a
    message). Not a wire difference; recorded because the code does not do what the number says.

## Order and dependencies

T1b.1 → T1b.2 → T1b.4, with T1b.3a beside T1b.1 (it touches only the socket) and T1b.3b after
T1b.1b and T1b.3a; T1b.5 last. T1a.8 (the proof script, the server-test list and
`native-loopback.process.test.ts`, at this brief's sha only on the unmerged
`ace/build-t1a-8-transport-proof-run`) must merge before T1b.2, T1b.3a's proof run and T1b.5. Each part is one builder round and one branch
(`ace/rust-transport-t1b-<part>`). Until T1b.3b merges, the native remote path negotiates no
extension, so `remote-compression.server` is off every on-leg list before T1b.5.

**server.ts is at 1,499 lines** (the hard limit is 1,500). No T1b task may grow it: T1b.1b first
moves the native listeners' start, unwind and shutdown steps into a new module (below), as a pure
move, and every later change to `server.ts` is net zero or negative.

---

### T1b.1a Rust: TLS termination and the remote listener

- **Files**: create `native/daemon/crates/ace-transport/src/{conn_io.rs,limits.rs,accept.rs}`,
  `src/tls/{mod.rs,provider.rs,identity.rs,resolver.rs,config.rs,handshake.rs,tests.rs}` and
  `src/remote/{mod.rs,listener.rs,tests.rs}` and `tests/{provider_installs.rs,provider_refuses.rs}`; change `driver.rs`, `listener.rs`, `prefixed.rs`,
  `lib.rs`, `error.rs`, `Cargo.toml`, `native/daemon/Cargo.lock`. Every file under 400 lines.
- **Crates** (versions in the local registry on 2026-11-24; `cargo deny check bans licenses sources`
  on the resolved feature graph, not only the direct licences):
  - `rustls` 0.23.46 (Apache-2.0 OR ISC OR MIT), with `default-features = false` and
    `features = ["aws_lc_rs", "prefer-post-quantum", "std", "tls12", "logging"]`, named
    explicitly rather than left to the defaults, so a later default change can't move the provider;
  - `tokio-rustls` 0.26.6 (MIT OR Apache-2.0),
    `default-features = false, features = ["aws_lc_rs", "tls12", "logging"]`;
  - **no direct `aws-lc-rs` dependency**: it is reached through `rustls::crypto::aws_lc_rs`.
    Resolved transitively: `aws-lc-rs` 1.19.0 (`ISC AND (Apache-2.0 OR ISC)`), `aws-lc-sys` 0.47.0
    (ISC, Apache-2.0, MIT and BSD-3-Clause, AND-ed with three OR-groups, `Apache-2.0 OR ISC`,
    `Apache-2.0 OR ISC OR MIT` and `Apache-2.0 OR ISC OR MIT-0`: every AND term is on `native/daemon/deny.toml`'s
    allowlist, and each OR has an allowed choice, so the allowlist needs no change; MIT-0 is never
    the term chosen), `rustls-webpki` 0.103.17 (ISC, with its `aws-lc-rs` feature), `rustls-pki-types`
    1.16.0 (MIT OR Apache-2.0, its `pem` module used through `rustls::pki_types`), `untrusted`
    (ISC), `zeroize`, `log` 0.4; at build time `cc`, `cmake` (MIT OR Apache-2.0), `dunce` (CC0-1.0 OR
    MIT-0 OR Apache-2.0), `fs_extra` (MIT), `pkg-config` (MIT OR Apache-2.0). No `ring`, no
    `rustls-pemfile` (unmaintained; pki-types replaces it), no `rcgen`, no `bindgen` feature.
  - **Gates**: `cargo tree -e features -i ring --target all` prints nothing (ring is now the one
    that must not appear); `cargo deny check bans licenses sources` passes on the resolved graph;
    `cargo tree -e features -i rustls` shows `prefer-post-quantum` on.
  - **Builds**: aws-lc-sys 0.47 compiles AWS-LC with its `cc` builder and pre-generated bindings on
    macOS (arm64, x86_64), Linux (x86_64, aarch64, glibc) and Windows x86_64 MSVC; it falls back to
    CMake (`cmake` 3.x on `PATH`) where its `cc` builder doesn't cover the target, and then needs
    `bindgen` and libclang, which this task does not add: a target that asks for them stops the
    task and is reported. **Windows**: rustls' `aws_lc_rs` feature turns on aws-lc-rs's
    `prebuilt-nasm`, so the x86_64 assembly needs no NASM install; if `AWS_LC_SYS_PREBUILT_NASM=0`
    is set on a machine, NASM must be on `PATH`. The release build
    (`cargo build --release --locked -p ace-daemon-node`) passes on the Mac, on omarchy and on the Windows VM, and the addon's size
    increase is noted in the PR. `scripts/` release tooling needs no change: the addon is one file.
- **The stream seam** (`conn_io.rs`): `pub trait ConnIo: AsyncRead + AsyncWrite + Unpin + Send + 'static {}`
  for `TcpStream` and `tokio_rustls::server::TlsStream<TcpStream>`. `driver.rs` runs over
  `Prefixed<Box<dyn ConnIo>>` instead of `Prefixed<TcpStream>`; `UpgradeHandler::upgrade_raw` takes
  that type. Loopback passes a boxed `TcpStream`; nothing else in T1a's behaviour changes.
- **Limits** (`limits.rs`), replacing the driver's constants with data:

  ```rust
  pub struct ConnectionLimits {
      pub handshake: Option<Duration>,        // TLS only; None on loopback
      pub first_head: Duration,               // from accept (or handshake end) to the first head
      pub head: Option<Duration>,             // a later head, from its first byte; None: only the idle timer bounds it
      pub keep_alive: Duration,               // idle, no request in flight, not trusted
      pub trusted_keep_alive: Option<Duration>, // None: the trust marker is ignored (T1b.2)
      pub exchange: Option<Duration>,         // whole-exchange deadline; None = Node's requestTimeout 0
      pub upgrade_write: Duration,            // TimedIo's bound on a 101 or a refusal (5 s)
  }
  impl ConnectionLimits {
      pub fn loopback() -> Self;       // T1a's values, unchanged
      pub fn remote_static() -> Self;  // handshake 120 s, first_head 10 s, head Some(10 s), keep_alive 5 s, trusted None, exchange None
      pub fn remote_sni(l: SniLimits) -> Self; // handshake l.handshake, first_head l.headers, head None, keep_alive, trusted Some(l.trusted_keep_alive), exchange None
  }
  ```

  `SniLimits { handshake, headers, keep_alive, trusted_keep_alive }` mirrors
  `sni-listener.ts:12`–`:26`, defaults `:28`–`:33`. **Where each value comes from**, so nothing is
  guessed:

  | Listener | Today's source                                                                                                        | Value here                                        |
  | -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
  | static   | `node:tls` `handshakeTimeout` default                                                                                 | `handshake` 120 s                                 |
  | static   | `listener.headersTimeout = 10_000` (`server.ts:278`), checked because the server listens                              | `first_head`, `head` 10 s                         |
  | static   | `requestTimeout = 0` (`server.ts:277`)                                                                                | `exchange` None                                   |
  | static   | `keepAliveTimeout` default 5 s                                                                                        | `keep_alive` 5 s, `trusted_keep_alive` None       |
  | SNI      | `handshakeTimeout: limits.handshake` (`sni-listener.ts:108`)                                                          | `handshake`                                       |
  | SNI      | `expire(…, limits.headers)` from `secureConnection` until the first `request` (`:152`, `:159`)                        | `first_head`                                      |
  | SNI      | the inner HTTP server never listens, so Node never runs its `headersTimeout` and `requestTimeout` checks on it        | `head` None, `exchange` None                      |
  | SNI      | a later head: the idle timer armed when the last answer closed keeps running until the next `request` (`:161`–`:169`) | bounded by `keep_alive` / `trusted_keep_alive`    |
  | SNI      | `http.keepAliveTimeout = max(keepAlive, trustedKeepAlive)` (`:103`–`:105`), set past both so it never fires first     | not ported: Rust's own idle timer is the only one |

  A reviewer compares each row with the source line it names. **Write timeout**: the bound is a shared
  `WriteTimeout` (`prefixed.rs`, new) so the connection's I/O and its upgrade handler change the
  same value. On a remote connection it is `None` for hyper's HTTP — Node bounds no HTTP write, and
  a slow 3G peer stalls longer than 5 s — and the upgrade handler arms `upgrade_write` for the
  `101` or a refusal, then drops it again once the socket is a WebSocket (raw path:
  `set_write_timeout(None)` before `opened`; hyper path: after the upgrade resolves). That is what
  keeps a stalled `101` from holding `close()` past its deadline: the upgrade arms the connection's
  grace, so the deadline no longer cancels it, and only the write bound ends it. Loopback keeps
  its timed HTTP and loses the bound on the WebSocket it opens, as Node has it.

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
  and Tailscale's ECDSA keys), the provider's `key_provider.load_private_key`, and `CertifiedKey::keys_match()` so a key that doesn't belong to the certificate
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

- **Config** (`tls/config.rs`): `server_config(provider: Arc<CryptoProvider>, resolver) -> Result<ServerConfig, TransportError>`,
  pure over the provider it is handed: `ServerConfig::builder_with_provider(provider)`,
  `.with_protocol_versions(&[&TLS13, &TLS12])` (Node's `minVersion: "TLSv1.2"`, max 1.3),
  `.with_no_client_auth()`, `.with_cert_resolver(resolver)`; `alpn_protocols = [b"http/1.1"]`
  (`sni-listener.ts:107`, and `node:https`'s default); `ticketer = rustls::crypto::aws_lc_rs::Ticketer::new()?`;
  `max_early_data_size = 0` (no 0-RTT, as Node); the cipher suites in Node's order
  (`TLS13_AES_256_GCM_SHA384`, ChaCha20-Poly1305, `TLS13_AES_128_GCM_SHA256`, then the TLS 1.2
  AEAD suites in the same strength order) with `ignore_client_order = true`, because Node honours
  the server's order (a 2026-11-24 probe offered ChaCha20 first and Node chose AES-256-GCM) and
  rustls' default follows the client's; no `key_log`, ever. The key exchange groups are the
  provider's `DEFAULT_KX_GROUPS` with `prefer-post-quantum`, unchanged (`X25519MLKEM768`, X25519,
  P-256, P-384), and the client's order decides among them (recorded difference 2). **The process provider** (`tls/provider.rs`, new, the crate's one boundary to it):
  `pub fn process_provider() -> Result<Arc<CryptoProvider>, TransportError>` installs
  `rustls::crypto::aws_lc_rs::default_provider()` with `install_default` on its first call and
  returns `CryptoProvider::get_default()`; if a provider was already installed, it is accepted only
  when its `kx_groups` start with `X25519MLKEM768`, else
  `TransportError::CryptoProvider` and no remote listener starts. Only the binding calls it
  (T1b.1b); `RemoteListener::bind` takes the provider as an argument, so tests pass their own.
- **Handshake** (`tls/handshake.rs`): `TlsAcceptor::accept` under `limits.handshake`; a stall,
  failure or timeout drops the TCP stream (Node's `tlsClientError` → `destroy`,
  `sni-listener.ts:136`). It returns the stream and the negotiated server name (`Option<String>`,
  for T1b.2).
- **The listener** (`remote/listener.rs`):

  ```rust
  pub struct RemoteListener { /* local addr, resolver, CancellationToken, accept task */ }
  impl RemoteListener {
      pub async fn bind(addr: SocketAddr /* any: 0.0.0.0 for the LAN, the 100.x address on Tailscale */,
                        provider: Arc<CryptoProvider>, identity: TlsIdentity, limits: ConnectionLimits,
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
  `http/1.1` chosen, a client offering only `h2` refused, `X25519MLKEM768` negotiated with a client
  that offers it and X25519 with one that doesn't, resumption with a ticket; the provider — a
  second call returns the installed one, and a provider installed first whose `kx_groups` don't
  start with `X25519MLKEM768` (aws-lc-rs's own, reordered: the tests never build ring) is refused,
  each in its own integration-test file (`tests/provider_installs.rs`, `tests/provider_refuses.rs`)
  because the install happens once per process; the listener —
  a request through TLS reaches a local hyper target with `x-ace-hop-*` set from the real peer.
  The client in these tests is `tokio-rustls`'s `TlsConnector` with a custom verifier that checks
  the SPKI SHA-256 against the expected one, the way ace pins.
  **The listener's limits are not tested here.** `sni-listener.process`'s cases (handshake stall,
  no request, idle keep-alive, a WebSocket not cut off, closing) are the proof for both listeners:
  T1b.4 makes them run against whichever listener the switch selects, the same case off and on.
  Rust gets no copy of them.
- **Must not**: call `install_default` anywhere but `process_provider`; enable `ring`; read the
  clock in the resolver; log or format key bytes;
  bind the hop target anywhere but 127.0.0.1; touch the binding or TypeScript.
- **Reviewer checks**: `cargo tree -e features -i ring --target all` prints nothing; deny
  passes on the resolved graph with `deny.toml` unchanged; the release build and `cargo test -p ace-transport` pass on macOS, Linux and the Windows
  VM; T1a's crate tests pass unchanged.

### T1b.1b The binding, the TypeScript shell and the static listener

- **Files**: create `native/daemon/crates/ace-daemon-node/src/transport/remote.rs`; change
  `transport.rs` (the module list, and `NativeLoopback.handled()` with the same counts); change `packages/provider-kit/src/native-transport.ts`;
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
          firstHeadMs: number;
          headMs: number | null;
          keepAliveMs: number;
          trustedKeepAliveMs: number | null;
        };
      },
      admit: NativeLoopbackAdmit, // T1a.5's three callbacks, same shapes
      release: (reservation: number) => void,
      opened: (socket: NativeSocketHandle, reservation: number, userAgent: string | null) => void,
      error: (code: string, message: string, repeated: number) => void, // after bind (difference 12)
    ): Promise<NativeRemote>; // resolves once bound; never waits on a certificate or the network
    port(): number;
    setTrusted(name: string, cert: Buffer, key: Buffer): void; // throws on unusable PEM
    clearTrusted(): void;
    /** What this listener handled since it bound, for the evidence file (T1b.5). */
    handled(): {
      connections: number;
      exchanges: number;
      upgrades: number;
      trustedHandshakes: number;
      postQuantumHandshakes: number; // negotiated_key_exchange_group() was X25519MLKEM768
      deflatedOut: number;
      inflatedIn: number;
    };
    close(deadlineMs: number): Promise<void>;
  }
  ```

  `checkIdentity` and `start` call `ace_transport::tls::process_provider()` (T1b.1a) first and
  throw its error unchanged; nothing else in the addon touches the provider. `error` carries the
  first failure of each OS code at once and then one call a minute per code with `repeated`, the
  count since; the shell turns it into `options.log(new Error(message))`, as `sni-listener.ts:187`
  does.

  A bind failure rejects with an `Error` whose `code` is the OS's (`EADDRINUSE`,
  `EADDRNOTAVAIL`), as `bindListener`'s does, so `remoteDirect`'s catch (`remote-direct.ts:147`)
  reports the same words.

- **The shell** (`native-remote.ts`): `startNativeRemote(options): Promise<NativeRemoteListener>`
  where the options name the bind address, the identity (`{ key, cert }` Buffers from
  `loadIdentity`), the limits, the per-boot hop secret (the loopback's, T1a.7:
  `transport.remote` needs `transport.loopback`), the internal server's port, and a
  `NativeUpgrade` built with `kind: "remote"`. **Evidence**: with `ACE_TRANSPORT_EVIDENCE` set it
  appends lifecycle lines as Rust reports them, `{ "pid", "listener", "port", "event" }` with
  `event` one of `bind` (Rust bound; `port` is the bound one), `bind-failed` (with the OS `code` and
  the requested port), `close-requested` (with `bound: false` when `close` ran before the bind
  landed) and `close`, and the close line carries the counts:
  `{ "pid", "listener": "remote", "port", "event": "close", …handled() }`; `noteTransportStart` gains `listener`
  (`"loopback"` or `"remote"`) and `event` fields in every line, T1a's included, and the loopback
  listener writes the same lines with its own counts. A bind line only proves a bind; the close line
  says what that listener, on that port, handled. **Per-case counts**: the shell keeps the live
  native listeners of this process in one evidence registry (in `native-transport.ts`'s evidence
  helper, created only when the variable is set, the only module state T1b adds, and never read by
  logic), and `flushTransportEvidence()` appends one `handled` line per live listener with the
  counts since its last line; T1b.5's case markers call it, so traffic lands in the case that made
  it, not only in the close line of a fixture shared by several cases. It holds the public port with
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

- **Needs**: T1b.1b, and T1a.8 merged (its `native-loopback.process.test.ts` holds the guard
  table this task extends; at this brief's sha it is only on `ace/build-t1a-8-transport-proof-run`).
- **Files**: change `native/daemon/crates/ace-transport/src/{hop.rs,proxy.rs,driver.rs}`, create
  `src/conn_state.rs`; change `apps/daemon/src/{proxy-guard.ts,http-peer.ts,sni-listener.ts}`,
  `apps/daemon/src/external-mcp/server.ts` and `apps/daemon/src/native-loopback.process.test.ts`
  (the guard table only); create `apps/daemon/src/native-remote.process.test.ts`.
- **Connection state** (`conn_state.rs`), one per accepted connection, shared by its requests:
  `pub struct ConnState { servername: Option<String>, trusted: AtomicBool }`. The servername comes
  from the handshake (T1b.1a); `trusted` starts false and only ever goes true.
- **One reserved list, both sides.** `hop.rs:21`–`:22`'s `RESERVED` grows from four names to six:
  `x-ace-hop-servername` and `x-ace-hop-trust` join the T1a four, and every rule that applies to the
  four applies to them (case-insensitive match, every instance removed). `proxy-guard.ts`'s
  `HOP_HEADERS` (`:9`–`:15`) grows the same way, so `withoutHopHeaders` (`:85`, defined `:92`–`:102`) and the
  `delete` loop (`:84`) remove both from `headers` and `rawHeaders`.
- **Hop, request direction** (`hop.rs`): every client-sent instance of the six is removed, then
  the four T1a fields are added as today and `x-ace-hop-servername` exactly once when the
  connection has a server name, never otherwise. `x-ace-hop-trust` is never sent upstream.
- **Hop, response direction**: every instance of the six in the internal server's answer is
  removed. If an `x-ace-hop-trust` was `1` and the listener has `trusted_keep_alive`, `trusted`
  becomes true before the head is written. Then Rust adds `keep-alive: timeout=<⌊limit/1000⌋>`,
  limit being `trusted_keep_alive` when trusted, else `keep_alive` (`sni-listener.ts:96`–`:100`,
  `:49`). On the static listener (`trusted_keep_alive` None) the marker is dropped and the value is
  always 5.
- **Timers** (`driver.rs`), as T1b.1a's limits table says: the first head within `first_head` of
  the handshake's end (`sni-listener.ts:152`); no idle timer while any request is in flight
  (`:155`–`:160`); when the last finishes, close after `trusted_keep_alive` if trusted, else
  `keep_alive` (`:161`–`:169`), the timer running until the next head completes (SNI) or the
  `head` limit applying (static); dropped without `close_notify`, as `socket.destroy()`; an
  upgraded connection leaves every HTTP timer (`:172`–`:181`).
- **The guard** (`proxy-guard.ts`), in addition to T1a.7's checks:
  - **any `x-ace-hop-trust` on a request is `403`**: Rust removes every client copy and never sends
    one upstream, so a request carrying it did not come from the hop;
  - at most one `x-ace-hop-servername`, matched case-insensitively over `rawHeaders` as `oneValue`
    does (`:24`–`:33`), so `X-Ace-Hop-Servername` beside `x-ace-hop-servername` is two and is `403`;
    its value 1–253 characters of `[a-z0-9.-]` (what rustls hands over, difference 4), else `403`;
  - absent: admitted, with `servername: null`.
- **`http-peer.ts`**: `HttpPeer` gains `servername: string | null` and `viaHop: boolean`; the guard's
  `setPeer` sets `viaHop: true` and the servername; the fallback (no hop) reads
  `socket instanceof TLSSocket && typeof socket.servername === "string" ? socket.servername : null`,
  moved here from `external-mcp/server.ts`, so the switch-off path reads exactly what it reads today.
- **`keepTrusted`** (`sni-listener.ts:44`–`:50`): when `peerOf(request).viaHop`, set
  `x-ace-hop-trust: 1` on the response (if headers aren't sent) and return; otherwise today's body,
  unchanged.
- **Outside MCP and webhooks on the Tailscale listener** (`external-mcp/server.ts`), every read of
  the connection mapped to `peerOf(request)` and nothing else changed:

  | Line          | What it reads today                                                    | Reads instead                  |
  | ------------- | ---------------------------------------------------------------------- | ------------------------------ |
  | `:251`–`:252` | the webhook's `socket.servername` (`tailscaleHook`)                    | `peerOf(request).servername`   |
  | `:253`–`:261` | `tailscaleBase({ host, servername }, …)` for the webhook               | unchanged, fed the value above |
  | `:286`        | `isHookPath(path)` routing to the webhook, else outside MCP            | unchanged                      |
  | `:289`–`:290` | outside MCP's `socket.servername`                                      | `peerOf(request).servername`   |
  | `:292`–`:296` | `tailscaleBase` for outside MCP, else `false` (falls to daemon routes) | unchanged                      |
  | `:300`        | `request.headers["x-ace-outside-peer"] = request.socket.remoteAddress` | `= peerOf(request).address`    |

  `:300` still overwrites any client copy of `x-ace-outside-peer`, so per-caller limits key on the
  real peer through the hop too. `TLSSocket` is no longer imported there.

- **Tests, moved and extended, not duplicated**:
  - `hop.rs`'s existing tests module gains rows for the two new names: a client's
    `X-Ace-Hop-Servername` and `x-ace-hop-servername` (mixed case, both) are both removed and one
    from the handshake is added; with no SNI none is added; a client's `x-ace-hop-trust` in any case
    never goes upstream; every response-direction copy of the six, in any case, is removed.
  - no Rust timer tests: the untrusted and first-head limits are `sni-listener.process`'s cases and
    the trusted limit is `keepAliveCases`', each run against the selected listener from T1b.4.
  - `native-loopback.process.test.ts`'s guard table ("the proxy guard refuses everything that did
    not come through the hop, and only admits a valid hop") gains rows, both legs: a request-side
    `x-ace-hop-trust` (lower and mixed case); two servername values differing only in case; a
    malformed servername; an absent one (admitted, `peerOf(…).servername === null`); a valid one
    (admitted, the value recorded, the header gone from `headers` and `rawHeaders`).
  - `native-remote.process.test.ts` is new, allowed because nothing drives these through the
    daemon today (its header says so), against a daemon with `remoteConfig` on Tailscale at
    127.0.0.1 (as `tailscale-https.server`'s `tailnetDaemon`), both legs:
    - an outside MCP request at the ts.net name is served by the outside MCP chain, and the same
      request naming another host falls through to the daemon's routes (`:292`–`:296`);
    - with `remote.tailscaleWebhooks` on, a webhook path at the ts.net name reaches the webhook,
      and at the 100.x address it doesn't (`:251`–`:264`);
    - two outside MCP callers' requests from one client, each claiming a different
      `x-ace-outside-peer`, share one per-caller budget (`:300`);
    - a handler's `x-ace-hop-trust` never reaches the client, and a client's never reaches a
      handler.
  - The keep-alive limits through a real paired-machine call stay in
    `machines/keep-alive-test-support.ts`'s `keepAliveCases`, which T1b.4 makes run on the native
    listener; nothing here repeats them.
  - Then, off and on, each alone: `native-remote.process`, `native-loopback.process`,
    `remote.server`, `access-cors.server`, `tailscale-https.server`.
- **Must not**: forward `Keep-Alive` from the internal server; read the trust marker on loopback;
  change `keepTrusted`'s Node path; keep a second list of hop names anywhere.
- **Reviewer checks**: `RESERVED` and `HOP_HEADERS` name the same six; `machines/http.ts:61` and
  `transfers/http.ts:61` call `keepTrusted` before any write (difference 9 stays theoretical); each
  row of the MCP table matches the diff.

### T1b.3a Rust: our own WebSocket framing, both listeners

- **Files**: create `native/daemon/crates/ace-transport/src/frame/{mod.rs,header.rs,read.rs,write.rs,assemble.rs,tests.rs}`;
  change `src/socket/drive.rs`, `src/socket.rs`, `Cargo.toml`. `tokio-tungstenite` moves to
  `[dev-dependencies]` (the client in tests, so every socket test stays cross-implementation);
  `tungstenite` stays for `derive_accept_key` only.
- **What it is** (T1b.0 §5 item 3, written fresh from RFC 6455 §5), in two layers, so a message
  is never whole before it is checked:
  - `frame/read.rs`: `Stream<Item = Result<Frame, FrameError>>` over the connection's
    `Box<dyn UpgradeIo>`, **one item per frame**: `Frame { fin, rsv1, opcode, payload: Vec<u8> }`,
    unmasked. Before reading a payload it asks the assembler whether the frame's length still fits
    (`admits(len)`), so a data frame that would take the message's wire bytes past 1 MiB fails
    with 1009 from its header alone, as `receiver.js:441` does.
  - `frame/assemble.rs`: `Assembler` takes frames in order and feeds **each data fragment as it
    arrives** to a `MessageBody`:

    ```rust
    pub trait MessageBody: Send {
        /// One fragment's payload; returns the message's bytes so far, or the close code to fail with.
        fn feed(&mut self, fragment: &[u8], fin: bool) -> Result<usize, CloseCode>;
        fn finish(&mut self) -> Vec<u8>; // the whole message, exclusively owned
        fn reset(&mut self);
    }
    pub struct Plain { /* appends, refusing the byte past MAX_MESSAGE_BYTES with 1009 */ }
    ```

    T1b.3b adds `Inflating`, which inflates each fragment as it is fed and counts the output,
    so the 1 MiB post-inflate cap is enforced inside `feed`, during inflation, never after a
    message was assembled. Control frames between fragments go straight through.

  - `frame/write.rs`: `Sink<Outbound>` with `Outbound { opcode, rsv1: bool, payload: Bytes }`.
    Together they replace exactly what `WebSocketStream::from_raw_socket` did in `drive.rs:99`,
    `:125`–`:136`.
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
  `socket/tests/close.rs`, `upgrade/tests.rs` and `listener/tests.rs` pass **unchanged**; the
  frame-size cases there now go through `Plain` and `admits`. Then the T1a.8 list on loopback, on
  leg only (`ACE_TRANSPORT=native`), with T1a.8's `scripts/t1a-proof.ts`: every file `native` and
  passing. That script and `scripts/list-server-tests.ts` exist only on
  `ace/build-t1a-8-transport-proof-run` at this brief's sha, so this run waits for T1a.8 to merge.
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
- **Window bits, both directions** (`codec.rs`, one pure function the constructors go through):

  ```rust
  /// The window flate2 is built with; never outside 9..=15, whose constructors panic
  /// (flate2-1.1.11/src/mem.rs:218-228, :421-428).
  pub fn deflate_window(server_max_window_bits: Option<u8>) -> u8 { /* None → 15; 8 → 9; 9..=15 as given */ }
  pub const INFLATE_WINDOW: u8 = 15;
  ```

  What `ws` 8.22 on Node 26 does, measured for this brief: an offer of `server_max_window_bits=8`
  or `client_max_window_bits=8` is accepted and echoed as `=8`, and messages flow both ways intact;
  Node's raw inflater at 8 reads streams with distances past 256. So the answer echoes the offer's
  value unchanged (negotiation above), deflate is built with `deflate_window(…)`, and inflate always
  with 15 (recorded difference 13). Serving 8 as 9 is safe because zlib-rs 0.6.8 at level 6 caps
  the match distance at 250 with a 9-bit window, which is within an 8-bit window's 256 bytes (RFC
  7692 §7.2.1); that is a property of this backend at this level, so the tests check it against
  every corpus rather than trusting it, and a flate2 or zlib-rs upgrade reruns them.
  Values outside 8–15 never get here: negotiation refused them with the 400.

- **Codec**: raw deflate (`Compress::new_with_window_bits(Compression::new(6), false, deflate_window(…))`),
  `FlushCompress::Sync`, the trailing `00 00 ff ff` removed; `Inflating` (T1b.3a's
  `MessageBody`) inflates (`Decompress::new_with_window_bits(false, INFLATE_WINDOW)`) **each
  fragment as `feed` receives it**, into 16 KiB chunks, the trailer appended after the final
  fragment, counting output per chunk: **the byte that takes the message past 1 MiB fails `feed`
  with 1009, inside the inflate loop** (exactly 1 MiB passes); a corrupt stream → 1007
  (`permessage-deflate.js:528`). Both contexts reset after every message (no context takeover,
  both ways, always).
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
  limited to 10; `deflate_window` for every value from 8 to 15 and `None`, each constructor built
  without a panic. **No byte-equality assertion** against Node or between windows.
  **An 8-bit-window decoder** (`deflate/tests/window8.rs`, test-only, written fresh from RFC 1951):
  a raw-deflate decoder whose history is 256 bytes and which fails with `DistanceTooFar` on any
  back-reference past it, the window a client that sent `server_max_window_bits=8` is entitled to
  (RFC 7692 §7.2.1). It decodes, intact and without that error: the codec's output with
  `deflate_window(Some(8))` for a repetitive corpus, a random one, a 200 KiB JSON transcript and a
  message of exactly 1 MiB; and, **on the wire**, the payload of every RSV1 frame a real
  `RemoteListener` sends to a raw client in an in-crate test that upgrades with
  `Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=8` and reads frames itself
  (the answer echoes `=8`). A negative control proves the decoder discriminates: the same corpora
  deflated with `deflate_window(Some(15))` must fail it.
  **Interop with `ws`** goes in `native-remote.process.test.ts` (both legs, so `ws` itself shows the
  expected answer on the off leg): a `ws` client offering `server_max_window_bits=8`, and another
  offering `client_max_window_bits=8`, each gets the answer echoing `=8` with both
  no-context-takeover parameters, and a 13 KiB message goes each way intact. (Node's inflater does
  not enforce the 8-bit window, so this case proves negotiation and interop, not the window; the
  decoder above proves the window.) Then, off and on, each
  alone: `remote-compression.server`, `remote-payloads.process`, `remote.server`,
  `native-remote.process`, and T1a.8's list on loopback (on leg).
- **The unified feature graph**: flate2 with `zlib-rs` changes the backend for every flate2 user in
  the workspace (`procfs` on Linux). So `cargo deny check bans licenses sources` and
  `cargo build --release --locked -p ace-daemon-node` run on the Mac, on omarchy and on the Windows
  VM in this task, with `cargo tree -e features -i flate2 --target all` in the PR showing `zlib-rs`
  and no C zlib (`libz-sys`, `libz-ng-sys`).
- **Must not**: decide to compress anything in Rust beyond the threshold; compress control frames;
  negotiate on loopback.
- **Reviewer checks**: the negotiation table's expected values come from running `ws`; the
  inflate cap aborts mid-stream (a 2 KiB frame inflating to 2 MiB allocates under 1.1 MiB).

### T1b.4 Run-time toggling of the native remote listeners

- **Files**: change `apps/daemon/src/{remote-direct.ts,remote-runtime.ts,sni-listener.ts,tailscale-certificate.ts,native-remote.ts,native-listeners.ts}`;
  create `apps/daemon/src/native-sni-listener.ts` and the test support below.
- **The seam that already exists**: `remoteDirect`'s `listener` factory
  (`remote-direct.ts:35`–`:38`). `remoteRuntime` gains an optional `listener` it passes through;
  with `remote` on, `native-listeners.ts` hands it `nativeSniListeners(deps).make`, and `attach`
  for a native listener's internal server only tracks it and destroys its upgrades.
- **`native-sni-listener.ts`**: `nativeSniListeners(deps: { secret: string; upgrades: NativeUpgrade; delay; now; tunnel }): { make(options: SniListenerOptions): SniListener }`.
  `make`:
  - reads `options.tls.key` and `options.tls.cert` (the pinned identity; `SNICallback` is ignored)
    and calls `NativeRemote.checkIdentity` **synchronously**, so an unusable identity throws from
    `makeListener` where `createServer` throws today (`remote-direct.ts:133`);
  - builds this listener's own internal server, `createServer(proxyGuard(secret, options.requests))`,
    as `sniListener` builds one HTTP server per listener (`sni-listener.ts:96`), and returns it as
    `http`;
  - `listen(host, port)`: binds the internal server, then `startNativeRemote` with
    `remote_sni(options.limits)`, resolving with the port once Rust bound; a rejection carries the
    OS `code` and closes the internal server first, so `remoteDirect`'s catch
    (`remote-direct.ts:147`–`:155`) can call `close()` on a listener that never bound;
  - `close()`: idempotent; waits for a `listen` still in flight, then closes Rust with deadline 0,
    then the internal server; resolves even when nothing was bound;
  - post-bind errors: the binding's `error` callback goes to `options.log`
    (`sni-listener.ts:185`–`:188`'s `front.on("error", options.log)`; recorded difference 12).
- **Certificates, with their lifecycle.** `SniListener` gains optional
  `trust?(certificate: TrustedCertificate | undefined): void` (Node's `sniListener` doesn't
  implement it: its `SNICallback` reads `trusted` lazily). `remoteDirect` calls
  `listener?.trust?.(trusted)` after it replaces `trusted` (`remote-direct.ts:117`–`:129`) and after
  it makes a listener (`:133`). `TrustedCertificate` gains `served(): TailscalePem | undefined` (the
  PEM it serves while `active()`) and `onServed(listener: () => void): () => void`, fired after a
  fetch installs a new certificate (`:115`–`:119`) and on `stop`. The native listener keeps one
  `{ certificate, unsubscribe, cancelTimer }` and:
  - `trust(next)`: unsubscribes from the previous certificate and cancels its timer **first**, then
    subscribes to `next`; if the listener is bound it syncs at once;
  - **after bind it syncs**: `trust` usually runs before `listen` resolves, and a certificate
    fetched before that (`trusted.ready` settled, `served()` already set) must reach Rust then, not
    at the next renewal;
  - sync: cancel the timer; `served()` undefined → `clearTrusted()`; else `setTrusted(name, cert,
key)`, and **if that throws, log it and `clearTrusted()`**, so Rust never keeps serving the
    certificate TypeScript replaced; then arm the injected `delay` for
    `min(expires - now(), 2_147_483_647)` ms to sync again (a timer can't hold more; a 90-day
    certificate re-arms), so the certificate leaves Rust when TypeScript stops calling it active;
  - `close()` unsubscribes and cancels the timer before closing Rust; nothing calls Rust after it.
- **Retire and re-open** (`takeDown`, `remote-direct.ts:65`–`:77`): `disconnect()` terminates
  `remoteSockets` (native ones included), then the listener closes with deadline 0, dropping every
  connection but an upgrade in `Writing`; such a socket's `opened` arrives later and the wiring
  terminates it (settings-only retire) or gives it `closer.gracefulClose(socket, 1001, "Daemon shutdown")`
  (daemon closing), matching the `disconnect` callback (`server.ts:1332`–`:1347`; recorded
  difference 8). A move to a new address is a close then a fresh `make` and `listen` on the same
  port, which `SO_REUSEADDR` allows on Unix.
- **Bind failure, retry and close during bind**, through the code that owns them, unchanged:
  a failed `listen` (`remote-direct.ts:143`–`:155`) closes the listener, stops the certificate
  and reports "Couldn't listen on port …"; `remote-runtime.ts:239`–`:243` logs it and schedules the
  retry, whose next commit makes a fresh listener; a bind that lands after `close`
  (`remote-direct.ts:157`–`:163`) is closed there. The native shell only has to make those calls
  safe in any order (the `close` rules above).
- **`remoteStarted`'s semantics, unchanged**: `directStarted` settles when the first commit's
  `listen` resolved or failed (`remote-runtime.ts:203`–`:214`), and `listen` resolves on bind, not
  on the certificate; both promises settle on close and never reject; listening never waits for
  remote access (behaviour.md §2).
- **Test support learns the switch; the cases move with it, not into new files.** Create
  `apps/daemon/src/sni-test-support.ts` with `testSniListener(options, certificate?)`: Node's
  `sniListener` (with `SNICallback` from `certificate.select`) when `transportParts()` lacks
  `remote`, else `nativeSniListeners({ secret: NativeLoopback.generateSecret(), … }).make(options)`
  followed by `trust(certificate)`. Then, each a moved hunk the reviewer compares:
  - `remote-direct.process.test.ts`'s gated wrapper (`:51`–`:70`) moves to
    `remote-direct-test-support.ts` over `testSniListener`; the file's two cases ("a bind that
    finishes after remote access closed leaves nothing listening", "moving to Tailscale as remote
    access closes opens no listener and fetches no certificate") now exercise close during bind
    natively on the on leg;
  - `machines/keep-alive-test-support.ts` (whose `keepAliveCases` both
    `machines/sni-keep-alive.process` and `machines/sni-keep-alive-on-node.process` run) builds its
    listener with `testSniListener`, and counts connections by `peerOf(request)`'s
    `address:remotePort` and observes their closing from the client's socket, instead of collecting
    `request.socket` (`:59`–`:70`), which through the hop is the hop's connection; the cases' names
    and assertions stay;
  - `tailscale-https.server.process.test.ts`'s two listener-building cases (":285 a renewed
    Tailscale certificate is served to new connections without restarting the listener", ":326 the
    pin gives way only to a trusted certificate for the exact ts.net name asked for") build through
    `testSniListener(…, certificate)`: they then prove renewal and the name rule through Rust;
  - `sni-listener.process.test.ts`'s `start` (`:21`–`:52`) builds through `testSniListener` and a
    second helper in `sni-test-support.ts`, `testSocketServer(listener, onOpen)`: with Node's
    listener it wires `ws`'s `handleUpgrade` to `listener.http`'s `upgrade` event as the file does
    today; with the native one it passes a `nativeUpgrade` wiring whose `opened` hands the socket
    to `onOpen`. It returns `clients()` (the open sockets, `MainSocket`s), so the closing case's
    `client.close(1001, "Daemon shutdown")` runs on either. The port-reuse step at the end of the
    closing case (`:153`) builds through `testSniListener` too. The raw TLS and TCP clients stay as
    they are. All five cases then run against the selected listener, once per leg, and nothing else
    tests those limits;
  - `tls-identity-node.process` runs its own Node TLS server: it passes on both legs and proves
    nothing about Rust.
    `native-remote.process.test.ts` gains only what no moved case covers: an expired Tailscale
    certificate leaves Rust at its expiry on the injected clock (native-only); an upgrade in flight
    during a settings retire never leaves an open socket (native-only); a LAN port taken at start is
    reported, and once freed the listener serves on the next retry (both legs, through
    `remote-runtime.ts:239`–`:243`).
- **Tests (off, then on, each alone)**: `remote-runtime.server`, `tailscale-https.server`,
  `remote-direct.process`, `sni-listener.process`, `machines/sni-keep-alive.process`,
  `machines/sni-keep-alive-on-node.process`, `native-remote.process`, and `remote-restart.server`
  (Windows only: counted on the VM run).
- **Must not**: move any decision of `remote-runtime.ts` or `remote-direct.ts` into Rust; make
  `listen` wait on the network; read `Date.now()` in the shell; change a moved case's assertions.
- **Reviewer checks**: with the switch off, `remote-direct.ts` and `remote-runtime.ts` behave
  identically (the new calls are optional-chained no-ops on Node's listener); no timer over
  2³¹−1 ms; a retired certificate's subscription and timer are gone (no `setTrusted` after
  `trust(other)` or `close`); the fixture moves are hunk-for-hunk.

### T1b.5 The proof run, Autobahn and the bench

- **Needs**: T1a.8 merged. Its `scripts/t1a-proof.ts`, `scripts/list-server-tests.ts` and
  `apps/daemon/src/native-loopback.process.test.ts` exist at this brief's sha only on
  `ace/build-t1a-8-transport-proof-run` (3151f6dffc); nothing below refers to them before then.
- **Files**: change `scripts/t1a-proof.ts` (generalized, not copied: `--switch=<value>`, default
  `native`, and the evidence rules below; T1a's run is the default and unchanged), and
  `tools/perf-kit/src/isolated-daemon.ts` (passes `ACE_TRANSPORT`, `ACE_TRANSPORT_ADDON` and
  `ACE_TRANSPORT_EVIDENCE` from the bench's own environment into the daemon, refusing a set switch
  whose addon path is unset, relative or names no file, as T0.1's `daemonEnv` does); create
  `scripts/transport-evidence-case.ts`, `native/daemon/crates/ace-transport/examples/autobahn_echo.rs` and
  `native/daemon/crates/ace-transport/autobahn/fuzzingclient.json`.
- **Run**: `node scripts/t1a-proof.ts --switch=native,remote` over T1a.8's whole list (discovery
  unchanged), off leg with the three variables removed, on leg with `ACE_TRANSPORT=native,remote`.
  T1a.8's labels and exit rules apply, and **evidence must name the listener and port that handled
  the work, per case, not only a bind**. Each leg runs with
  `--setupFiles scripts/transport-evidence-case.ts` (new): its `beforeEach` appends
  `{ "event": "case", "name": <expect.getState().currentTestName>, "pid" }`, its `afterEach` calls
  `flushTransportEvidence()` and appends `{ "event": "case-end" }`. A file's tests run in order in
  one worker, so the lines between a case's markers are that case's, including those of a daemon
  child that case started and stopped. The script then checks, per executed case:
  - every start line in a file's evidence has a close line with the same `pid`, `listener` and
    `port` (T1b.1b); a start without a close is `NONE`, since its counts are unknown;
  - **traffic cases**: every case of `remote.server`, `remote-boundaries.server`,
    `remote-runtime.server`, `remote-compression.server`, `tailscale-https.server`,
    `remote-payloads.process`, `access-cors.server`, `ticket-allocation.server`,
    `sni-listener.process`, `machines/sni-keep-alive.process`,
    `machines/sni-keep-alive-on-node.process` and `native-remote.process` (and
    `remote-restart.server` on Windows) needs, inside its own markers, a remote `handled` or
    `close` line with `connections > 0` and, unless the case is listed below, `exchanges + upgrades > 0`; `remote-compression.server`'s "delivers a large thread…" and "closes a remote
    socket whose message inflates past the payload limit" need `deflatedOut > 0` and `inflatedIn > 0` respectively; `tailscale-https.server`'s ts.net cases need `trustedHandshakes > 0`;
    `remote.server`'s "consumes a socket ticket once and accepts it on a pinned WSS connection"
    needs `postQuantumHandshakes > 0` (its client is Node's, which offers `X25519MLKEM768`);
  - **lifecycle cases**, whose proof is what the listener did rather than traffic, each checked
    against its own markers:

    | Case                                                                                                                  | Evidence required in its window                                                                                                                              |
    | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | `remote-direct.process` "a bind that finishes after remote access closed leaves nothing listening"                    | `bind` on port P only after the case's `remote.close()` ran (the gate holds it), then `close-requested` with `bound: true` and `close` on P, `connections` 0 |
    | `remote-direct.process` "moving to Tailscale as remote access closes opens no listener and fetches no certificate"    | one `bind` (the LAN port), its `close`, and no second `bind`                                                                                                 |
    | `native-remote.process` "a LAN port taken at start is reported, and once freed the listener serves on the next retry" | `bind-failed` with `EADDRINUSE` on P, then `bind` on P, then a `handled` line on P with `exchanges > 0`                                                      |
    | `sni-listener.process` "closing drops waiting and idle connections at once and leaves WebSockets to their server"     | `close` on P, then a second `bind` on P (the port reuse)                                                                                                     |
    | `sni-listener.process` "a client that stalls in the TLS handshake is disconnected, and the listener keeps serving"    | `connections > 0` and `exchanges > 0` on the one listener (the second client was served)                                                                     |

  - **exempt cases** (no listener by design: pure TypeScript inside a listed file) are named in the
    script with the reason, starting with `tailscale-https.server`'s "a Tailscale certificate that
    expires while renewals fail stops being offered"; the reviewer confirms each;
  - every other file keeps T1a.8's file-level rule, read from close lines: at least one loopback
    `close` line with `exchanges + upgrades > 0`;
  - every `bind` has a `close` with the same `pid`, `listener` and `port` before the file ends; a
    case missing its evidence is `NONE`, and the run exits non-zero;
  - the printed table lists, per file and case, each listener and port with its lifecycle events
    and counts.
    macOS, Linux and the Windows VM.
- **Autobahn** (the owner, 2026-11-24: yes, a local offline step, never CI). `autobahn_echo.rs` is
  a dev-only example (never built into the addon) that serves T1b.3a's framing and T1b.3b's
  negotiation and codec with ace's options over plain TCP on `127.0.0.1:9001` and echoes every
  message (TLS is rustls', already fuzzed upstream). `fuzzingclient.json` runs every case (`"*"`)
  against it with `permessage-deflate` offered. Run on omarchy with the
  `crossbario/autobahn-testsuite` image already pulled (pulling it is the only network step, done
  beforehand with the owner's go-ahead):
  `docker run --rm --network host -v "$PWD/native/daemon/crates/ace-transport/autobahn:/config" -v /tmp/ace-autobahn:/reports crossbario/autobahn-testsuite wstest -m fuzzingclient -s /config/fuzzingclient.json`.
  The same suite then runs against a scratch `ws` 8.22 echo server with `remoteDeflate` on the same
  port. Pass: no case `FAILED` for ours, and no case where `ws` is `OK` and ours is not; `NON-STRICT`
  and `INFORMATIONAL` results are listed in the PR beside `ws`'s. The reports stay in `/tmp`; only
  the summary goes in the PR.
- **Cross-mode (rollback)**: a daemon started on, stopped, and started off on the same home (and
  the reverse) serves the same fingerprint, keeps paired devices, and a paired device reconnects
  after minting a fresh ticket (tickets live in memory either way). Rust writes nothing to disk, so
  nothing is migrated. `remote.server`'s restart cases, run once with `ACE_TRANSPORT` changed
  between the two starts, are this check.
- **Bench pairing** (owner-scheduled, one at a time, both legs on the T1b head build, A B A B, three
  pairs, a pair void when load differs by more than 2× or the on leg's evidence lacks a remote
  close line with handled exchanges):

  | Bench                                                                                      | Metric                                                             | On must be                             |
  | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------- |
  | `bun apps/daemon/bench/head-of-line.ts --paths=direct --profiles=3g-slow,3g-fast --runs=3` | `stopAck` and `sendReceipt` medians, idle and under each bulk kind | ≤ off × 1.10                           |
  | same                                                                                       | event-loop gaps (p99)                                              | ≤ off × 1.10                           |
  | same                                                                                       | bytes delivered ahead of each urgent message, per bulk kind        | within ±3% of off (compression parity) |
  | `bun run --filter @ace/daemon bench:slow-link` (direct legs)                               | each reported latency median; bytes per scenario                   | ≤ off × 1.10; bytes ±3%                |
  | `node tools/daemon-bench/src/run.ts --output=<file>` with `ACE_LISTEN=lan`                 | T1a's rows (`cpuMsPerTurn`, idle CPU, heap, RSS)                   | T1a's thresholds                       |

  The relay benches (`relay-connect`, `relay-resume`) don't touch these listeners and are T6's. If
  any median fails, T1b stays opt-in, as T1a. aws-lc-rs's post-quantum handshake costs more CPU
  than X25519 alone; the handshake share shows in the head-of-line runs' connect phase and is
  reported, not gated.

- **Owed by the owner, not a builder** (ADR 0226 answer 1): the ace web app over the ts.net name in
  a real browser with the switch on, and the iPhone client paired over the LAN, each opening a
  thread with a long transcript, the browser's security panel showing `X25519MLKEM768`, and the
  evidence file's `postQuantumHandshakes` counting the iPhone's connections.

## Failure modes on restart and reconnect (AGENTS.md priority 2)

| Event                                                        | What happens, both legs                                                                                                                           | Where it is held                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Daemon restart, same home                                    | `tls/` is read, never regenerated; same fingerprint; links issued before pair once after (`remote.server`)                                        | T1b.1a identity, T1b.1b           |
| Restart switching backend either way                         | the same, plus tickets voided (in memory) and re-minted by device tokens                                                                          | T1b.5 cross-mode                  |
| Remote port still in `TIME_WAIT` after a stop                | binds again (`SO_REUSEADDR` on Unix, as libuv)                                                                                                    | T1b.1a test                       |
| Port taken by another program                                | `listen` rejects with the OS code; status says "Couldn't listen on port …"; loopback and relays keep serving                                      | T1b.1b; `remote-runtime.server`   |
| Port freed after a failed bind                               | the retry (`remote-runtime.ts:239`–`:243`, backing off from 1 s) makes a fresh listener, which serves                                             | T1b.4; `native-remote.process`    |
| A different rustls provider already installed in the process | `process_provider` refuses it; no remote listener starts, status reports the error; loopback serves                                               | T1b.1a, T1b.1b                    |
| Tailscale renewal Rust can't load                            | logged; Rust clears the old certificate and serves the pin until the next good one                                                                | T1b.4                             |
| Unusable identity or Tailscale key                           | identity: `make` throws as `createServer` does; Tailscale: logged, pin served                                                                     | T1b.4                             |
| Settings retire, move to a new address, Tailscale on/off     | sockets terminated, listener closed at once, a late `opened` closed, reservations of that listener released, pending links withdrawn as today     | T1b.4                             |
| Stop while a bind or a certificate fetch is under way        | the bind that lands closes (`remote-direct.ts:157`–`:163`); the fetch is abandoned; shutdown never waits on the network                           | T1b.4 shell close waits the start |
| Reconnect storm after restart (every device at once)         | TLS handshakes on tokio, not the pump; pre-auth budgets (64 remote, 16 per address) and the 256 cap unchanged; 1,024 TCP connections per listener | T1b.1a; recorded difference 7     |
| Certificate renewed or expired while connections are open    | open connections keep theirs; new handshakes get the new one, or the pin after expiry                                                             | T1b.4                             |
| A panic in a connection task                                 | that connection drops; the listener keeps accepting; a panic in an export becomes a JS error (`catch_unwind`)                                     | T1b.1a, T1b.1b                    |
| Daemon crash                                                 | the listener dies with the process; nothing on disk to repair                                                                                     | —                                 |

## Owner decisions (2026-11-24)

1. **Post-quantum key exchange**: aws-lc-rs with `prefer-post-quantum`, installed as the process
   provider, not ring (decision 4). ADR 0226's TLS row says so.
2. **Sends without options compress** when large, as `ws` does, for parity (decision 7).
3. **Autobahn**: yes, as a local, offline step of T1b.5, not CI.
