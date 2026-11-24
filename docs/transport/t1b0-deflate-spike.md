# T1b.0: per-message deflate in the Rust transport (spike)

Date: 2026-11-24. Status: spike report, no code merged. Answers ADR 0226 answer 1
(`docs/adr/0226-the-daemon-leaves-bun.md:539`–`:543`) and the T1b.0 brief
(`docs/transport/porting-guide.md:793`). The two prototypes were throwaway crates under `/tmp`,
deleted after the run; this file is the only change.

## 1. What the daemon does today (the contract to match)

`ws` 8.22 with `remoteDeflate` (`apps/daemon/src/compression-policy.ts:61`–`:69`):
`serverNoContextTakeover: true`, `clientNoContextTakeover: true`, `threshold: 1024`,
`concurrencyLimit: 10`, `zlibDeflateOptions: { level: 6, memLevel: 8 }`, on the remote listeners
only (`apps/daemon/src/server.ts:282`–`:286`; loopback is `:280`, no extension).

1. **Negotiation, no context takeover both ways, forced.** `acceptAsServer` writes
   `server_no_context_takeover` and `client_no_context_takeover` into the response whether or not
   the offer named them (`ws/lib/permessage-deflate.js:184`–`:191`), then resets deflate and
   inflate after every message (`:457`, `:390`). It accepts browser-shaped offers and ignores
   `client_max_window_bits` out of the response, so the client keeps its 15-bit window.
2. **Outbound allowlist.** `mayCompress(message.type)` over 20 bulk types
   (`compression-policy.ts:25`–`:46`), decided per message in the outbox
   (`apps/daemon/src/outbox.ts:246`) and sent as `{ compress }` (`:311`–`:329`); event batches and
   snapshot fragments always compress (`:311`). Uncompressed messages never share a packed frame
   with compressed ones (`:320`–`:323`). On top of that `ws` applies the 1 KiB threshold, only
   because no-context-takeover was negotiated (`ws/lib/sender.js:382`).
3. **1 MiB post-inflate cap, enforced while streaming.** `maxPayload: 1024 * 1024` reaches
   `PerMessageDeflate` (`ws/lib/websocket-server.js:305`); `inflateOnData` counts bytes as zlib
   produces them and fails with 1009 the moment the total passes 1 MiB, without buffering the
   rest (`ws/lib/permessage-deflate.js:484`–`:500`). Exactly 1 MiB passes. The compressed payload
   has its own 1 MiB cap (`ws/lib/receiver.js:441`).
4. **RSV1 without negotiation is fatal, 1002.** `ws/lib/receiver.js:232`–`:240`
   (`WS_ERR_UNEXPECTED_RSV_1`), also for a continuation frame (`:248`–`:257`).
5. The proof is `apps/daemon/src/remote-compression.server.process.test.ts`: extension present on
   a remote socket, a ~200 KiB snapshot under a quarter of its bytes on the wire, loopback
   uncompressed, and a 2 MiB `ping` that arrives as ~2 KiB and closes `1009`.

## 2. Candidate crates

Licences are the `license` field of the published crate; maintenance is crates.io's release date
and the repository's open-issue count on 2026-11-24. `native/daemon/deny.toml` allows
Apache-2.0/MIT/BSD/ISC/Zlib/Unicode/Unlicense/CC0 and says MPL-2.0 stays out.

| Crate                                     | Version  | Licence                             | Released   | Issues | NCT both ways  | Streaming cap | Fits the hyper/tungstenite path | Verdict         |
| ----------------------------------------- | -------- | ----------------------------------- | ---------- | ------ | -------------- | ------------- | ------------------------------- | --------------- |
| `tungstenite`/`tokio-tungstenite`         | 0.30.0   | MIT OR Apache-2.0                   | 2026-07-11 | 56     | n/a            | n/a           | is the path; no extension hook  | no 7692         |
| `fastwebsockets`                          | 0.10.0   | Apache-2.0                          | 2025-01-14 | 19     | n/a            | n/a           | throughput-first, no hyper glue | no 7692         |
| `tokio-websockets`                        | 0.13.3   | MIT                                 | 2026-06-25 | 3      | n/a            | n/a           | tokio-util codec, no hyper      | no 7692         |
| `soketto`                                 | 0.8.1    | Apache-2.0 OR MIT                   | 2024-12-02 | 12     | no (echo only) | no            | replaces the socket layer       | no              |
| `yawc`                                    | 0.5.0    | **MPL-2.0**                         | 2026-10-22 | 1      | yes            | yes           | replaces the socket layer       | denied          |
| `hpx-yawc`                                | 2.6.1    | Apache-2.0 field, MPL-2.0 `LICENSE` | 2026-11-07 | 1      | yes            | yes           | hyper-native, axum extractor    | blocked         |
| `shiguredo_websocket`                     | 2026.3.0 | Apache-2.0                          | 2026-05-28 | 0      | yes            | yes           | sans-io, needs an adapter       | no allowlist    |
| `ws-pmd`                                  | 0.1.0    | MIT                                 | 2026-08-28 | 0      | yes            | yes           | sans-io, no framing at all      | unreviewed      |
| `parity-ws`                               | 0.11.1   | MIT                                 | 2021-10-28 | —      | unknown        | unknown       | blocking, `ws-rs` lineage       | unmaintained    |
| our own, in `ace-transport` over `flate2` | —        | Apache-2.0                          | —          | —      | yes by design  | yes by design | one `Sink/Stream<Message>` swap | **recommended** |

### What each source actually says

- **tungstenite 0.30.0 / tokio-tungstenite 0.30.0** — `read_message_frame` fails any frame with a
  reserved bit set: `tungstenite-0.30.0/src/protocol/mod.rs:636`–`:646` (the check at `:643`).
  `WebSocketConfig` (`src/protocol/mod.rs:46`–`:95`) has no extension hook and `Message` has no
  compressed form, so this cannot carry RFC 7692 in either direction. Its **raw** frame layer is
  public and does model RSV1: `FrameSocket` (`src/protocol/frame/mod.rs:29`) and
  `FrameHeader { is_final, rsv1, rsv2, rsv3, opcode, mask }` (`src/protocol/frame/frame.rs:40`–`:48`).
  That layer is blocking (`FrameSocket::read` takes `impl Read`), and its read path hardcodes
  `unmask = false` (`src/protocol/frame/mod.rs:82`), so a server would still unmask and assemble
  messages itself. No fork or feature adds 7692: the crate has no extension hook, and the one
  published fork of a deflate-capable crate (`hpx-yawc`) is a fork of `yawc`, not of tungstenite. A
  patch would be ours to carry across releases.
- **fastwebsockets 0.10.0** — "permessage-deflate is not supported yet" (`src/lib.rs:76`) and any
  RSV bit is `ReservedBitsNotZero` (`src/lib.rs:684`–`:686`).
- **tokio-websockets 0.13.3** — no compression: nothing in `src/` mentions deflate or `rsv1`, and
  the feature list (`Cargo.toml`, `[features]`) has no compression feature.
- **soketto 0.8.1** — has a real extension (`src/extension/deflate.rs`, 323 lines) but as a
  **server** its `configure` clears its own params and only echoes the client's
  `server_no_context_takeover` / `client_no_context_takeover`
  (`src/extension/deflate.rs:143`–`:192`), so a client that offers neither gets context takeover —
  the exact thing `compression-policy.ts` forbids. `decode` inflates into an unbounded `Vec`
  (`:258`–`:261`), so no streaming cap; the host's message limit applies after the fact. It is
  also its own tokio codec stack, not a layer over tungstenite.
- **yawc 0.5.0** — `license = "MPL-2.0"` (`Cargo.toml:53`, `LICENSE` is MPL-2.0). File-level
  copyleft, excluded by `deny.toml`'s allowlist on purpose.
- **hpx-yawc 2.6.1** — a `yawc` fork (its README), publishing `license = "Apache-2.0"`
  (`Cargo.toml:52`) while shipping yawc's **MPL-2.0** `LICENSE` file. Even setting the licence
  aside it does not fit: `Streaming` compresses every non-control frame
  (`src/native/streaming.rs:442`–`:449`) with no per-message opt-out and no threshold; the inflate
  ceiling is the read buffer (`src/native/mod.rs:282`) and its overflow is an `io::Error` mapped to
  `CloseCode::Error` (`src/native/streaming.rs:262`–`:271`), not 1009. Its RSV1 error is correct
  (`:310`–`:318`, 1002) but the close frame did not reach the wire (see §3).
- **shiguredo_websocket 2026.3.0** — the closest off-the-shelf fit: sans-io, `max_decompressed_size`
  (`src/websocket_connection_shared.rs:300`), a compression threshold, and no-context-takeover
  configuration (`src/deflate/permessage_deflate.rs:44`–`:46`), Apache-2.0 and active
  (`shiguredo/websocket-rs`). `send_text` (`src/websocket_server_connection.rs:561`) has no
  compress flag and `compress_if_enabled` decides from a constant
  (`src/websocket_connection_shared.rs:273`–`:283`), so the allowlist cannot be expressed. 7 stars,
  one maintainer, Japanese-only source docs.
- **ws-pmd 0.1.0** — MIT, sans-io, and semantically the best match: a hard
  `DecompressedLimit` that refuses the byte past the limit (`src/codec.rs:56`–`:90`, `:396`–`:430`)
  and a server that **imposes** both no-context-takeover parameters (`src/server.rs:124`–`:127`).
  But it is one release, 0 stars, ~3,400 lines of security-sensitive code that no third party has
  reviewed, and it owns no framing. Good to read, not to depend on yet.

## 3. Prototypes

Two servers, both on hyper 1 with `hyper::upgrade::on` (the T1a/T1b path), both driven by the same
suite written against the real `ws@8.22.0` client from `node_modules`, mirroring
`remote-compression.server.process.test.ts`.

- **`own`** (425 lines): our own server framing that exposes RSV1 (123 lines), raw deflate/inflate
  over `flate2` 1.1 with the 1 MiB streaming ceiling (43 lines), negotiation and the message loop.
- **`hpx-yawc 2.6.1`** with `DeflateOptions { level: 6, server_no_context_takeover: true,
client_no_context_takeover: true }`, `with_max_payload_read(1 MiB)`, `with_max_read_buffer(1 MiB)`.

| Check (each one a clause of §1)                                              | own               | hpx-yawc           |
| ---------------------------------------------------------------------------- | ----------------- | ------------------ |
| negotiates with both no-context-takeover params, accepted by `ws`            | pass              | pass               |
| 200 KiB bulk arrives intact, 287× fewer bytes                                | 204 823 → 712     | 204 823 → 713      |
| no context takeover: an 8 KiB incompressible message repeated costs the same | 5 204 / 5 204     | 5 206 / 5 206      |
| a message the allowlist refuses goes uncompressed                            | 204 823 → 204 833 | **fail**, 714      |
| a message under the 1 KiB threshold goes uncompressed                        | 15 bytes          | **fail**, 18 bytes |
| inflates two 100 KiB client messages (per-message inflate reset)             | pass              | pass               |
| exactly 1 MiB after inflation is accepted                                    | pass              | pass               |
| 1 MiB + 1 byte after inflation closes **1009**                               | 1009              | **fail**, 1006     |
| a ~2 KiB frame that inflates to 2 MiB closes **1009**                        | 1009              | **fail**, 1006     |
| RSV1 with no negotiation closes **1002**, and no extension is offered        | 1002              | **fail**, no frame |
| a client that never offered the extension still gets messages                | pass              | pass               |

`own` passed 11/11; `hpx-yawc` passed 5 of the 9 checks it reached, then hung on the RSV1 check
because the connection is dropped with no close frame (a raw probe read 0 bytes after the `101`).
Its 1006 on the inflate cap is the same failure: the close it queues never reaches the peer.

The no-context-takeover check is discriminating, proved by a negative control: the same 8 KiB
payload through one shared `zlib.createDeflateRaw` stream costs 5 127 then **78** bytes, while a
fresh context per message costs 5 122 and 5 122. A takeover implementation would fail the 5%
tolerance by two orders of magnitude.

The `own` prototype also showed a real trap: on the first run it compressed bulk replies before
checking whether the extension had been negotiated, and a `ws` client that never offered it failed
the connection. The send path must gate on the handshake, not only on the policy.

## 4. Recommendation

**Build the extension in `ace-transport` ourselves: an RFC 7692 module over `flate2`, on our own
server framing that exposes RSV1, behind the same `Sink<Message>`/`Stream<Item = Message>` seam
`tokio-tungstenite` occupies today (`native/daemon/crates/ace-transport/src/socket/drive.rs:99`,
`:125`–`:136`).** Keep `tungstenite` only for `derive_accept_key`
(`ace-transport/Cargo.toml` already depends on it for the handshake).

Why: every crate that has RFC 7692 fails one of the four clauses, and the failures are structural,
not bugs to wait out — yawc and its Apache-labelled fork are MPL-2.0, soketto cannot force
no-context-takeover and cannot cap inflation, shiguredo and hpx-yawc cannot leave a message
uncompressed, and tungstenite's `WebSocketConfig` has no extension hook at all. Nothing can both
reuse today's socket layer and satisfy §1. Owning the ~170 lines of protocol code the prototype
needed (123 framing, 43 DEFLATE), tested against the real `ws` client, is cheaper than owning a fork
of tungstenite's frame parser, and it is what ADR 0226 already names as the fallback.

### Risks and how T1b.3 holds them

- **We own RFC 6455 framing**, which `tokio-tungstenite` gave us hardened. Mitigation: the
  prototype is 123 lines because a server needs no mask generation and no fragment sending; the
  Rust tests keep `tokio-tungstenite` as a **dev-dependency peer** (it is already the client in
  `socket/tests.rs:22`–`:28`), so every socket test is cross-implementation, and the Autobahn
  fuzzing server is the release gate for the framing half.
- **One framing implementation, not two.** T1a's `drive.rs` moves onto the new layer with the
  loopback listener (which still never negotiates, `server.ts:280`), so the compression path and the
  plain path cannot drift.
- **The 1 MiB boundary must be inclusive and the close must be 1009** exactly as `ws` does it; the
  prototype pins all three cases (1 MiB accepted, 1 MiB + 1 byte → 1009, a 2 KiB frame that
  inflates to 2 MiB → 1009) and the cap must abort during inflation, never after buffering.
- **Compression bombs** are bounded twice: the compressed frame at 1 MiB and the inflated message at
  1 MiB, both counted incrementally. CPU stays at level 6, per message, no context — the same work
  the daemon does today.
- **The allowlist stays TypeScript.** Nothing in Rust may decide to compress: `outbox.ts:246` →
  `MainSocket.send(…, { compress })` (`main-socket.ts:14`, `native-socket.ts:92`–`:97`). Rust adds
  only `ws`'s threshold rule.
- **A future buy-in.** If `ws-pmd` (MIT) survives a security read, it can replace our DEFLATE state
  machine without touching framing; that is the one place a dependency is worth reconsidering.

## 5. What T1b.3 needs to build

1. `crates/ace-transport/src/deflate/negotiate.rs`: parse `Sec-WebSocket-Extensions` (comma lists,
   quoted params, several offers, unknown params ignored as `ws` ignores them), choose
   `permessage-deflate`, always answer `server_no_context_takeover; client_no_context_takeover`,
   never echo `client_max_window_bits` unless we implement window bits. Reject a malformed offer by
   negotiating nothing rather than failing the handshake.
2. `crates/ace-transport/src/deflate/codec.rs`: `flate2` raw deflate, `Z_SYNC_FLUSH`, the RFC 7692
   trailer stripped on send and restored on receive, a fresh context per message in both
   directions, and `inflate` with a `limit` that returns a typed `MessageTooLong` **during** the
   loop. Typed errors: `MessageTooLong → 1009`, `BadDeflate → 1007`.
3. `crates/ace-transport/src/frame/`: server framing with `fin`, `rsv1`, opcode, 7/16/64-bit
   lengths, client-mask enforcement, continuation assembly, control frames (≤125 bytes, FIN),
   close-code validation, UTF-8 check for text, and one read buffer with no per-message allocation
   beyond the message. It must fail RSV1 on a data frame when the extension was not negotiated, and
   on a continuation frame always (1002). `MAX_MESSAGE_BYTES` (`socket.rs:36`) becomes both the
   compressed and the post-inflate limit.
4. Wire it behind `drive.rs`'s seam, carrying `{ binary, compress }` from `MainSocket` into the
   frame writer, and expose whether the connection negotiated the extension so the outbox can stop
   asking (it need not: `ws` also drops compressing when absent).
5. Tests: a table for negotiation (browser offer, `client_max_window_bits` with and without a value,
   two offers, a malformed one, no offer — §1.1), RSV1 in each position (§1.4), the three 1 MiB
   boundary cases (§1.3), a fragmented compressed message, a corrupt deflate stream, and both directions
   against the real `ws` client. Then the porting guide's T1b proof list off and on, starting with
   `remote-compression.server.process.test.ts`, plus `remote-payloads.process` for the 1 MiB
   payload rules.
