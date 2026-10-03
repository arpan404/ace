# Self-hosted encrypted relay

The relay is a fallback after LAN and Tailscale. The user runs it on infrastructure they control. ace operates no relay service and handles no provider credentials. The daemon integration worker chooses the route and validates device tokens inside the encrypted channel.

## API

`@ace/relay` exports:

- `startRelay({ port?, bind?, limits?, allowedHostIds?, clock?, now?, createTicket?, createConnectionId?, onBackpressure?, onThrottle? })`, returning `{ url, port, close, stats, sweep }`. The library binds to loopback on an ephemeral port by default. Stats contain buffer sizes and frame counts, never payloads. `now` remains a compatibility shorthand for a monotonic clock; use `clock` to inject both time and scheduling.
- `connectHostToRelay({ relayUrl, hostKeys, onClientChannel, signal?, clock?, limits? })`, returning `{ hostId, generation, whenRegistered(afterGeneration?), close }` after registration. Registration retries start at 250 ms and back off to 5 seconds. Abort cancels startup, retries and owned sockets. A newer proven registration replaces the old owner; an old helper receiving replacement code 4001 stops reconnecting.
- `connectClientViaRelay({ relayUrl, hostId, pinnedFingerprint, signal?, clock? })`, returning a client channel after pin verification. The host id must equal the pinned fingerprint.
- `readRelayConfig(env)` and the pure `RelayRoutes`, `IpBudget`, and `ClientSlots` policies. Their inputs are facts, ids and timestamps; they perform no socket or timer I/O.

Channels expose `send(message)`, `receive()`, async iteration, `close()`, `closed`, `bufferedBytes` and `bufferedReceiveBytes`. Host channels receive `ClientMessage` values and send `ServerMessage` values; client channels do the reverse. Schemas parse messages only at the endpoints. Consume with one reader and await sends. `closed` resolves with an error on network or authentication failure, and without one on local close. Local close also ends a pending async iterator normally; a pending direct `receive()` rejects.

**Host callbacks must authenticate the device.** Receive the first `hello`, verify its device id and token using daemon authorization, then call `channel.authorize()`. Close rejected channels. `authorize()` cannot precede a received hello. Receiving a syntactically valid hello alone does not authorize its token or cancel the deadline.

Host admission defaults to 64 channels and a 10-second deadline from the offer through handshake and device authorization. At capacity, a new offer evicts the oldest unauthorized channel. Authorized channels are retained; when every slot is authorized, the host rejects the offer over its encrypted control session and the relay closes the waiting client immediately. Configure `limits.maxClientChannels`, `helloTimeoutMs`, `handshakeTimeoutMs`, `retryInitialMs` and `retryMaxMs` at the host boundary.

The injected `Clock` has `now(): number` and `schedule(delayMs, callback): () => void`, where the returned function cancels the timer. Handshake, pairing, authorization, token refill, retry and sweep deadlines all use that clock. Default clocks and cryptographic ticket/id factories are constructed in the I/O shell.

A host reconnects after relay restarts with fresh ephemerals. Existing channels end on failure. Clients create a new channel, send an authenticated hello, and resume snapshot/replay using the daemon cursor. Helpers never replay commands or retransmit pending messages across cryptographic sessions.

## Registration and stream protocol

The host connects outbound to `/host` as Noise XX initiator using its persisted X25519 static key. The relay responds with a fresh key. The prologue is `ace relay registration v1`. After the handshake proves possession, the relay derives the id from the authenticated static public key. A claimed URL id has no authority. A fresh proven registration replaces and terminates a stale one immediately.

Registration uses Noise instead of an Ed25519 challenge to prove possession of the exact X25519 key defining the host id, without another identity key or signature binding. The control session carries encrypted registration confirmations, client offers and host busy rejections. It is separate from daemon traffic. Hosts do not pin the relay because it supplies routing, while clients pin the daemon endpoint.

A client connects outbound to `/client?hostId=...`. The relay creates a single-use, random 256-bit ticket valid for 10 seconds and offers it over the encrypted control session. The host opens an outbound `/join?ticket=...` socket. Expiry or rejection closes the waiting client. Once paired, the relay sends a one-byte readiness marker and forwards binary messages. Premature client data and text messages are rejected.

The client initiates Noise XX on the stream, and the host responds. Its prologue is `ace daemon relay stream v1`. The client verifies the responder key against the paired fingerprint before completing the handshake. Handshake payloads are empty. The relay sees public handshake values, host ids, addresses, tickets, timing and ciphertext sizes. It cannot read daemon messages or impersonate a pinned host. Modification, replay and reordering fail authentication and close the channel.

## Framing, limits and backpressure

Each WebSocket binary message is one Noise message, at most 65,535 bytes. Compression is disabled. JSON has a 16 MiB encoded limit and fragments into encrypted chunks. The final-fragment flag is encrypted; no plaintext logical length or sequence number is added. Non-final chunks have a fixed size, and directions rekey every `2^20` fragments.

Endpoints cap queued frames at 1 MiB and 256 entries, pausing at 256 KiB or 128 entries. Send queues and reassembly are capped at 16 MiB. JSON parsing and serialization allocate bounded copies of an admitted message; caller objects and consumer-retained messages are outside these queues. The 10 MiB test stalls the reader, verifies that another 10 MiB send is refused, then checks the complete payload and simultaneous reverse traffic.

The relay pauses a source when the destination reaches its high-water mark and resumes after its pending write drains. It closes both sides if a destination would exceed the hard buffer cap. A counted pause hold prevents rate refill and destination backpressure from accidentally resuming each other's readers. Binary messages and ping/pong frames share a FIFO token budget per IP. Exhaustion pauses the reader until refill instead of closing a busy stream. A small bound on pending control frames also prevents ping-flood allocation.

IP quotas use the real TCP peer and ignore forwarded headers. IPv4-mapped IPv6 shares its IPv4 quota; IPv6 peers share a `/64` quota. Address normalization happens once per connection. The table evicts the oldest inactive entry at capacity, retaining active connection quotas. Inactive entries also expire after 60 seconds. Behind a reverse proxy, configure the proxy's per-origin limits because the relay sees the proxy IP.

## Running

```sh
bun install
ACE_RELAY_PORT=8787 bun run --filter @ace/relay start
```

Numeric environment values must be decimal positive safe integers. Deadlines and host retry delays are at most 2,147,483,647 ms, the Node timer ceiling. Port is at most 65535, frame size cannot exceed the Noise ceiling, and the high-water mark cannot exceed the buffer cap.

| Environment variable               |                      Default |
| ---------------------------------- | ---------------------------: |
| `ACE_RELAY_PORT`                   |                         8787 |
| `ACE_RELAY_BIND`                   |                      0.0.0.0 |
| `ACE_RELAY_MAX_CONNECTIONS_PER_IP` |                          256 |
| `ACE_RELAY_MAX_CONNECTIONS`        |                         1024 |
| `ACE_RELAY_MESSAGES_PER_SECOND`    |                         1000 |
| `ACE_RELAY_MESSAGE_BURST`          |                         2000 |
| `ACE_RELAY_MAX_FRAME_SIZE`         |                        65535 |
| `ACE_RELAY_IDLE_TIMEOUT_MS`        |                        60000 |
| `ACE_RELAY_HIGH_WATER_BYTES`       |                       262144 |
| `ACE_RELAY_MAX_BUFFERED_BYTES`     |                      1048576 |
| `ACE_RELAY_MAX_IP_ENTRIES`         |                         4096 |
| `ACE_RELAY_HANDSHAKE_TIMEOUT_MS`   |                        10000 |
| `ACE_RELAY_TICKET_TIMEOUT_MS`      |                        10000 |
| `ACE_RELAY_ALLOWED_HOST_IDS`       | unset: allow any proven host |

For a personal relay, set `ACE_RELAY_ALLOWED_HOST_IDS` to comma-separated paired host fingerprints. An explicitly empty value denies every host. Admission still requires a successful possession proof. A connection limit of 256 accommodates a host control socket, 64 outbound joins and 64 clients behind the same IP.

Ping probes run every 10 seconds or half the idle timeout. Binary traffic and accepted control replies keep sockets live. The relay logs only its startup port, never frames, decrypted messages, ids, tickets or provider data.

Build from the repository root:

```sh
docker build -f apps/relay/Dockerfile -t ace-relay:test .
node apps/relay/bench/docker-smoke.ts
docker run --rm -p 8787:8787 ace-relay:test
```

The image installs with Bun and runs TypeScript on Node 24 as an unprivileged user. The container smoke test exchanges an authenticated hello and encrypted ping/pong through the actual image; Linux CI also builds and runs it. Use a user-operated TLS proxy with WebSocket upgrades and `wss://` for remote deployments. Disable query-string logging for join tickets. Daemon encryption does not rely on trusting relay TLS termination.

The Noise core is portable; these helpers use Node's `ws`. Browser and Expo bindings remain with the client workers. Pairing, token verification and daemon route selection remain with the remote-access worker.

See [performance measurements](performance.md), [mutation evidence](mutations.md), [Noise revision 34](https://noiseprotocol.org/noise.html), [ws API](https://github.com/websockets/ws/blob/master/doc/ws.md), and [secure-channel provenance](../../packages/secure-channel/README.md).

## Exclusive binary preview subchannels

Channels additionally expose `sendBinary(Uint8Array)` and `receiveBinary()`. After authenticating the initial JSON hello and calling the host's `authorize()`, a dedicated preview channel switches to binary receive. The owner acknowledges this switch over JSON before the client starts preview traffic. Do not interleave a JSON reader with a binary reader; one consumer owns each channel. `@ace/preview` supplies `previewRelayChannel` for that ownership contract.

Each encrypted plaintext begins with tag `2` followed by a single binary record, at most 65,518 bytes. Tags `0` and `1` retain the existing JSON-fragment meanings. Binary records reuse the ordered bounded send queue, rekey counters, receive-frame bounds and disconnect cleanup. They do not use JSON, Base64 or logical-message reassembly. Caller buffers are copied once into tagged plaintext at admission. Invalid record kind closes the encrypted channel. Authorization and approved preview ports still belong to the daemon.
