# 0110: The relay on Cloudflare Workers and Durable Objects

Status: accepted. Date: 2026-11-02. Owner decision of 2026-11-02. Builds on
[ADR 0070](0070-runtime-remote-access.md) and the relay contract in
[docs/relay](../relay/README.md). Amends [ADR 0002](0002-local-cli-providers.md) with a
second narrow hosted exception, alongside [ADR 0106](0106-ios-remote-push-gateway.md).

## Context

The relay (`apps/relay`) pairs a client socket with a daemon socket and forwards Noise
ciphertext between them. It has always been self-hosted. A person whose phone is away from
their LAN and Tailscale needs a relay that ace runs, or remote access does not work for them.

We compared a self-hosted Node container (Railway) with Cloudflare for 10,000 users. Traffic
through a relay leaves the provider once, so bandwidth sets the bill: about $0.05/GB on
Railway against none on Cloudflare. Estimated at 4 GB per person per month, that was about
$2,200 a month against about $80. Railway also needs one replica (routes are in memory) and
drops every socket on deploy.

## Decision

### The exception

ace runs the relay at a public `wss://` address. It is a forwarder only:

- It sees what the self-hosted relay sees: host ids, addresses, tickets, timing and
  ciphertext sizes. It cannot read daemon messages or impersonate a pinned host.
- It stores nothing beyond socket attachments that end with their sockets. It logs no
  frames, ids, tickets or addresses.
- The self-hosted Node relay stays supported, with the same wire contract.

### Shape

- A Worker (`apps/relay-cloudflare`) validates the path and query and routes each upgrade to
  a Durable Object named by the host id. Everything for one daemon (its control socket,
  waiting clients and paired streams) lives in that one object, so forwarding never crosses
  objects.
- Every socket uses the WebSocket Hibernation API. An object whose sockets are idle costs
  nothing; the runtime answers protocol pings without waking it. Without hibernation, each
  always-connected daemon would be billed for wall-clock time (about $60,000 a month at
  15,000 daemons), so no relay code may hold a timer, interval or pending promise while
  sockets are idle. The only timer is the handshake deadline, which ends with the handshake.
  Ticket expiry uses a Durable Object alarm.
- Routing policy is `RelayRoutes`, shared with the Node relay. After hibernation the object
  rebuilds it from socket attachments. Pure modules move out of `@ace/relay` into
  `@ace/relay/wire` so the Worker imports no Node code.
- The registration Noise session survives hibernation: each control socket's attachment
  holds its two cipher keys and nonces, rewritten after every control message. Control
  messages are rare (one per client connection), so this is cheap.

### Wire changes

- A daemon sends `hostId` on `/host` and `/join`. The Worker needs the id to pick the object
  before the handshake. It selects the object only: the object closes a registration whose
  proven key does not match its own name, and a join whose ticket it does not hold. The Node
  relay ignores the parameter, so new daemons keep working with self-hosted relays.
- Everything else (prologues, handshake, tickets, close codes, readiness marker, framing) is
  unchanged.

### Differences from the Node relay

- **Backpressure.** Workers WebSockets expose no `bufferedAmount`. The object cannot pause a
  fast sender for a slow receiver, so a large transfer to a slow phone can grow the object's
  memory (128 MB). Daemons already cap queued sends at 16 MiB per channel. Before a public
  launch, a staging test streams to a throttled client and measures memory; if it fails,
  the fix is end-to-end flow control in the channel, not in the relay.
- **Rate limits.** Per-IP connection budgets become a Workers rate-limit binding on upgrades.
  Per-socket frame rates are counted in memory and reset on hibernation.
- **Idle sockets.** The relay does not ping. Daemons already ping every 10 seconds and
  reconnect on silence; clients time out their own pairing.

### D1

The relay itself needs no routing database. D1 holds ace's account data (sessions, pending
logins) and the machine directory for the WorkOS account backend
([ADR 0100](0100-ace-account-backend.md), [ADR 0111](0111-account-machine-access.md)), which
runs in this Worker; see [accounts](../relay/accounts.md).

## Rejected

- **Railway or another container host.** No rewrite, but bandwidth charges, a single replica
  and dropped sockets on deploy.
- **Durable Objects without hibernation.** Simpler code, but billed for every connected
  second.
- **An Ed25519 challenge instead of the registration Noise session.** It would avoid saving
  cipher state, but it needs a second identity key and changes the daemon's proof. Saving
  two keys and two counters is smaller.

## Later

- Direct device-to-device connections (WebRTC data channels upgraded from a relayed session,
  carrying the same Noise channel) with this relay as fallback. Recorded so ADR 0088's
  "no WebRTC because ace would need TURN" can be revisited: the hosted relay is the fallback.

## Verification

- Unit tests: routing rebuilt from attachments after hibernation pairs, expires and rejects
  the same as before; cipher state restored from an attachment decrypts the next control
  message.
- A process test runs the Worker in Miniflare (real workerd) and drives it with the daemon's
  own `connectHostToRelay` and `connectClientViaRelay`: registration, an authenticated
  encrypted exchange, busy rejection, replacement, ticket expiry and a refused host whose
  claimed id does not match its key.

See [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
