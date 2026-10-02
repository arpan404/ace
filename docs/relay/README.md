# Self-hosted encrypted relay

The relay is a fallback after LAN and Tailscale. The user runs it on infrastructure they control. ace operates no relay service and handles no provider credentials. The daemon integration worker will choose the route and connect device-token authentication to the encrypted wire channel.

## API

`@ace/relay` exports:

- `startRelay({ port?, bind?, limits?, now?, onBackpressure? })`, returning `{ url, port, close, stats, sweep }`. The default library bind is loopback and port zero. `now` is a monotonic clock boundary and `sweep` runs cleanup explicitly for deterministic tests. Stats contain only buffer sizes and frame counts.
- `connectHostToRelay({ relayUrl, hostKeys, onClientChannel, signal? })`, resolving after initial registration. It returns `{ hostId, generation, whenRegistered(afterGeneration?), close }`. Each authenticated registration increments the generation; waiting for a generation after the current one observes a reconnect. Registration retries start at 250 ms and back off to 5 seconds. Abort cancels startup, retries and all owned sockets. Host helpers admit at most 64 active or handshaking client channels.
- `connectClientViaRelay({ relayUrl, hostId, pinnedFingerprint, signal? })`, returning a client channel after pin verification. Its host id must equal the pinned fingerprint.

Channels have `send(message)`, `receive()`, async iteration, `close()`, `closed` and `bufferedBytes`. Host channels receive existing `ClientMessage` values and send `ServerMessage` values; client channels do the reverse. Messages are schema-validated only at the endpoints. `send` promises serialize concurrent sends and wait for socket writes. Consume messages by one reader per channel and await sends to respect backpressure. `closed` resolves with an error for a network or authentication failure and without one for local `close()`.

A host registration survives relay restarts by reconnecting with fresh ephemerals. Existing stream channels end on network failure. The client calls `connectClientViaRelay` again, sends its normal authenticated `hello`, and resumes snapshot/replay using its daemon cursor. The helper does not replay commands or retransmit pending application messages across new cryptographic sessions.

## Registration and stream protocol

The host connects outbound to `/host` and acts as Noise XX initiator with its persisted X25519 static key. The relay is a responder with a fresh static key. The prologue is `ace relay registration v1`. After the final handshake proves the host possesses the private key, the relay derives the id from the authenticated static public key. A URL-supplied host id has no authority. A second registration of the same id is refused rather than replacing the live host.

The separate registration session was chosen over an Ed25519 challenge because it proves possession of the exact X25519 key that defines the host id. No additional identity key or signature-to-X25519 binding is needed. This control session carries only encrypted registration confirmation and client tickets. It is separate from daemon traffic and uses a different prologue. The host does not pin the relay's key because the relay is a routing service, not the endpoint trusted with daemon messages.

A client connects outbound to `/client?hostId=...`. The relay creates a random 256-bit ticket valid for 10 seconds and sends it to the host over the encrypted control session. The host opens an outbound `/join?ticket=...` socket. Tickets are single-use; a failed or expired join cannot leave the client stranded. Once paired, the relay sends the client a one-byte readiness marker and forwards binary messages in each direction. Premature client messages and text messages are rejected.

The client is Noise XX initiator on the paired stream, and the host is responder. The prologue is `ace daemon relay stream v1`. The client verifies the responder static key against its pairing fingerprint before completing the handshake. Handshake payloads are empty. The relay sees public handshake values, host ids, addresses, tickets, timing and ciphertext sizes. It cannot read daemon messages or generate a host handshake matching a different pinned private key. It can deny service or redirect traffic, but a redirected endpoint still must pass the pin check. Transport modification, replay and reordering fail authentication and close the channel.

## Framing and bounds

Each WebSocket binary message is one Noise message, at most 65,535 bytes. Compression is disabled. Application JSON has a 16 MiB encoded limit and fragments into encrypted chunks. A one-byte final-fragment flag is inside the ciphertext; no plaintext logical length or sequence number is added. Non-final chunks have a fixed size to bound fragment metadata, and directional transport rekeys occur every `2^20` fragments.

Each endpoint caps queued frames at 1 MiB and 256 entries, pausing the reader at 256 KiB or 128 entries. The sender caps pending encoded JSON at 16 MiB. The receiver caps reassembly at 16 MiB. JSON parsing and serialization also allocate bounded copies of an admitted logical message; caller-owned message objects and messages retained by consumers are outside these queues. The 10 MiB test stalls consumption until the relay reports backpressure, checks queue byte bounds, and then verifies the entire message and reverse traffic. It measures buffer accounting rather than imposing a garbage-collector-dependent RSS budget.

The relay pauses the source reader when the destination's `bufferedAmount` reaches its high-water mark and resumes below half that mark. It terminates both sides if the destination would exceed the hard cap. Limits cover aggregate traffic from an IP, including upgrades and WebSocket ping/pong messages. The relay also caps WebSocket fragment and buffered-chunk counts at 256. It uses the TCP peer IP and ignores forwarded-IP headers. Behind a reverse proxy, limits therefore apply to the proxy address; configure the proxy's own per-origin IP limits as well.

## Running

```sh
bun install
ACE_RELAY_PORT=8787 bun run --filter @ace/relay start
```

All numbers must be positive safe integers. Frame size must not exceed the Noise ceiling, and the high-water mark must not exceed the hard buffer cap.

| Environment variable               | Default |
| ---------------------------------- | ------: |
| `ACE_RELAY_PORT`                   |    8787 |
| `ACE_RELAY_BIND`                   | 0.0.0.0 |
| `ACE_RELAY_MAX_CONNECTIONS_PER_IP` |      64 |
| `ACE_RELAY_MAX_CONNECTIONS`        |    1024 |
| `ACE_RELAY_MESSAGES_PER_SECOND`    |    1000 |
| `ACE_RELAY_MESSAGE_BURST`          |    2000 |
| `ACE_RELAY_MAX_FRAME_SIZE`         |   65535 |
| `ACE_RELAY_IDLE_TIMEOUT_MS`        |   60000 |
| `ACE_RELAY_HIGH_WATER_BYTES`       |  262144 |
| `ACE_RELAY_MAX_BUFFERED_BYTES`     | 1048576 |

Ping probes run every 10 seconds or half the idle timeout, whichever is shorter. Binary traffic or accepted pong replies keep a live registration open; sockets with no activity expire. Handshakes and pending stream joins have separate 10-second deadlines. IP rate records without connections expire after 60 seconds, and the table caps at 4096 entries. The relay logs only its startup port, never frames, decrypted messages, ids, tickets or provider data.

Build from the repository root:

```sh
docker build -f apps/relay/Dockerfile -t ace-relay .
docker run --rm -p 8787:8787 ace-relay
```

The image installs with Bun and runs TypeScript directly on Node 24 as an unprivileged user. The Docker engine in the implementation environment did not respond, so the image build was not verified. A real encrypted host/client round trip passed on native Node 24.21.0, and the portable entry point bundled successfully for browsers. Expose it through the user's TLS reverse proxy with WebSocket upgrades enabled. Use `wss://` for remote deployments so routing metadata and ticket URLs are also protected in transit. The reverse proxy must not log join-ticket query strings. End-to-end daemon encryption does not rely on trusting TLS termination at the relay.

The Noise core is portable; these initial WebSocket helpers use Node's `ws` package. Browser and Expo workers will supply platform socket bindings while retaining the Noise core and framing rules. Device pairing, authorization and daemon route selection are intentionally left to the remote-access worker.

Primary references: [Noise revision 34](https://noiseprotocol.org/noise.html), [ws API](https://github.com/websockets/ws/blob/master/doc/ws.md), [secure channel and fixture provenance](../../packages/secure-channel/README.md). Mutation evidence is in [mutations.md](mutations.md).
