# Self-hosted encrypted relay

This Node relay is the self-hosted relay: anonymous registration, no accounts. ace's hosted
relay runs on Cloudflare (`apps/cloud`) with the same wire contract and adds
[ace account admission](accounts.md): there a daemon registers only with its account, and a
device reaches only machines on its own account.

The relay is a fallback after LAN and Tailscale. It can run on the user's own infrastructure. It handles no coding-provider credentials. The daemon integration worker chooses the route and validates device tokens inside the encrypted channel.

Every daemon channel can travel through it: the main conversation (a hello without `channel`), pairing redemption (`pair.redeem`, self-hosted relays only) and the files, devices, browser, screen and provider sign-in channels. The relay forwards ciphertext and cannot tell them apart.

## API

`@ace/relay` exports:

- `startRelay({ port?, bind?, limits?, allowedHostIds?, clock?, now?, createTicket?, createConnectionId?, onBackpressure?, onThrottle? })`, returning `{ url, port, close, stats, sweep }`. The library binds to loopback on an ephemeral port by default. Stats contain buffer sizes and frame counts, never payloads. `now` remains a compatibility shorthand for a monotonic clock; use `clock` to inject both time and scheduling.
- `connectHostToRelay({ relayUrl, hostKeys, onClientChannel, signal?, clock?, limits?, account? })`, returning `{ hostId, generation, whenRegistered(afterGeneration?), close }` after registration. Registration retries start at 250 ms and back off to 5 seconds. Abort cancels startup, retries and owned sockets. A newer proven registration replaces the old owner; an old helper receiving replacement code 4001 stops reconnecting. `account: { grant(signal), name?, platform? }` is for ace's hosted relay: `grant` returns a fresh `machine` grant before every registration, sent as the `ace.grant.<token>` subprotocol (a self-hosted relay ignores it).
- `connectClientViaRelay({ relayUrl, hostId, pinnedFingerprint, signal?, clock?, grant? })`, returning a client channel after pin verification. The host id must equal the pinned fingerprint. `grant` is a `device` grant for ace's hosted relay.
- A host the relay refuses for good (close 1008 after the upgrade, or HTTP 403 before it) stops instead of reconnecting: `connectHostToRelay` rejects with `RelayRefusedError`, or calls `onRefused` when it had registered before. A 401 or 503 before the upgrade is retried with a fresh grant and backoff.
- `readRelayConfig(env)` and the pure `RelayRoutes`, `IpBudget`, and `ClientSlots` policies. Their inputs are facts, ids and timestamps; they perform no socket or timer I/O.

Channels also expose `sendText(json, compress?)` and `receiveRaw()`, which pass JSON text without the schema parse, for an endpoint that encodes and parses messages itself (the daemon's main channel and the client's `relayRoute`). The first message of a host channel must still be a `hello` or a `pair.redeem`; a redemption channel is never authorized.

Channels expose `send(message)`, `receive()`, async iteration, `sendBinary(bytes)`, `receiveFrame()` and `frames()`, `close()`, `closed`, `bufferedBytes` and `bufferedReceiveBytes`. Host channels receive `ClientMessage` values and send `ServerMessage` values; client channels do the reverse. Schemas parse messages only at the endpoints. `receive()` and the original async iterator retain JSON-only behavior. `receiveFrame()` and `frames()` return either a typed protocol message or a `Uint8Array`. The file service adapter binds those frames after the host authenticates its hello. Consume with one reader and await sends. `closed` resolves with an error on network or authentication failure, and without one on local close. Local close also ends a pending async iterator normally; a pending direct `receive()` rejects.

**Host callbacks must authenticate the device.** Receive the first `hello`, verify its device id and token using daemon authorization, then call `channel.authorize()`. Close rejected channels. `authorize()` cannot precede a received hello. Receiving a syntactically valid hello alone does not authorize its token or cancel the deadline.

Host admission defaults to 64 channels and a 10-second deadline from the offer through handshake and device authorization. At capacity, a new offer evicts the oldest unauthorized channel. Authorized channels are retained; when every slot is authorized, the host rejects the offer over its encrypted control session and the relay closes the waiting client immediately. Configure `limits.maxClientChannels`, `helloTimeoutMs`, `handshakeTimeoutMs`, `retryInitialMs` and `retryMaxMs` at the host boundary.

The injected `Clock` has `now(): number` and `schedule(delayMs, callback): () => void`, where the returned function cancels the timer. Handshake, pairing, authorization, token refill, retry and sweep deadlines all use that clock. Default clocks and cryptographic ticket/id factories are constructed in the I/O shell.

A host reconnects after relay restarts with fresh ephemerals. Existing channels end on failure. Clients create a new channel, send an authenticated hello, and resume snapshot/replay using the daemon cursor. Helpers never replay commands or retransmit pending messages across cryptographic sessions.

## Registration and stream protocol

The host connects outbound to `/host` as Noise XX initiator using its persisted X25519 static key. The relay responds with a fresh key. The prologue is `ace relay registration v1`. After the handshake proves possession, the relay derives the id from the authenticated static public key. A claimed URL id has no authority. A fresh proven registration replaces and terminates a stale one immediately.

Registration uses Noise instead of an Ed25519 challenge to prove possession of the exact X25519 key defining the host id, without another identity key or signature binding. The control session carries encrypted registration confirmations, client offers and host busy rejections. It is separate from daemon traffic. Hosts do not pin the relay because it supplies routing, while clients pin the daemon endpoint.

A client connects outbound to `/client?hostId=...`. The relay creates a single-use, random 256-bit ticket valid for 10 seconds and offers it over the encrypted control session. The host opens an outbound `/join?ticket=...` socket. Expiry or rejection closes the waiting client. Once paired, the relay sends a one-byte readiness marker and forwards binary messages. Premature client data and text messages are rejected.

ace's hosted relay also forwards plain HTTPS requests to a daemon that registered with `features=http`: it sends an `http` ticket over the control session and the daemon opens `/serve?ticket=...` for one request and its response. This relay never sends `http` tickets. See [Public HTTP to a machine](accounts.md#public-http-to-a-machine).

The client initiates Noise XX on the stream, and the host responds. Its prologue is `ace daemon relay stream v1`. The client verifies the responder key against the paired fingerprint before completing the handshake. Handshake payloads are empty. The relay sees public handshake values, host ids, addresses, tickets, timing and ciphertext sizes. It cannot read daemon messages or impersonate a pinned host. Modification, replay and reordering fail authentication and close the channel.

## Framing, limits and backpressure

Each WebSocket binary message is one Noise message, at most 65,535 bytes. Compression is disabled. JSON has a 16 MiB encoded limit and fragments into encrypted chunks. Binary logical messages are capped at 64 KiB plus a 16-byte file envelope. Encrypted fragment kinds 0/1 retain JSON continuation/final framing; additive kinds 2/3 carry binary continuation/final fragments. Every fragment in a logical message must have the same kind. `sendBinary` copies admitted bytes so later caller changes cannot alter a queued encrypted message. The final-fragment flag is encrypted; no plaintext logical length or sequence number is added. Non-final chunks have a fixed size, and directions rekey every `2^20` fragments.

Endpoints cap queued frames at 1 MiB and 256 entries, pausing at 256 KiB or 128 entries. Send queues and reassembly are capped at 16 MiB. JSON parsing and serialization allocate bounded copies of an admitted message; caller objects and consumer-retained messages are outside these queues. The 10 MiB test stalls the reader, verifies that another 10 MiB send is refused, then checks the complete payload and simultaneous reverse traffic.

A relay may be unable to push back at all (ace's hosted relay on Durable Objects has no `bufferedAmount`), so the two ends can also limit themselves. A client whose hello lists `credit` in `flowControl` asks for it; the daemon turns it on for that channel by sending a credit fragment, before its welcome. A credit fragment's plaintext is tag `7` followed by a 4-byte big-endian count, at most 1 MiB. Each side's first credit fragment says its own data is flow controlled from that fragment on, and the other side answers with its own. From then on each side has at most a 1 MiB window of fragments in flight that its peer has not consumed, each fragment costing its plaintext length and at least 4 KiB (so a window is also at most 256 fragments). The reader returns credit as it takes fragments, once a quarter window is owed. Credit fragments are written at once, ahead of data waiting for credit, and frames are decrypted as they arrive so credit is never stuck behind unread data. A peer that overruns its window closes the channel. Peers that never asked see no credit fragments and keep the behaviour above; the Node relay forwards credit fragments like any other.

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

See [Noise revision 34](https://noiseprotocol.org/noise.html), [ws API](https://github.com/websockets/ws/blob/master/doc/ws.md), and [secure-channel provenance](../../packages/secure-channel/README.md).

## Exclusive binary preview subchannels

Channels additionally expose `sendBinary(Uint8Array)` and `receiveBinary()`. After authenticating the initial JSON hello and calling the host's `authorize()`, a dedicated preview channel switches to binary receive. The owner acknowledges this switch over JSON before the client starts preview traffic. Do not interleave a JSON reader with a binary reader; one consumer owns each channel. `@ace/preview` supplies `previewRelayChannel` for that ownership contract.

Each encrypted plaintext begins with tag `2` followed by a single binary record, at most 65,518 bytes. Tags `0` and `1` retain the existing JSON-fragment meanings. Binary records reuse the ordered bounded send queue, rekey counters, receive-frame bounds and disconnect cleanup. They do not use JSON, Base64 or logical-message reassembly. Caller buffers are copied once into tagged plaintext at admission. Invalid record kind closes the encrypted channel. Authorization and approved preview ports still belong to the daemon.
