# 0155: A returning client reaches the welcome one round trip after the relay socket opens

Status: proposed. Date: 2026-11-15. For review before any handshake code is written. Builds on
[ADR 0150](0150-fewer-connect-round-trips.md) (connect round trips), [ADR 0110](0110-cloudflare-relay.md)
and [ADR 0141](0141-ace-cloud.md) (the hosted relay), [ADR 0111](0111-account-machine-access.md)
(account grants), [ADR 0070](0070-runtime-remote-access.md) and the
[relay wire contract](../relay/README.md). Keeps [ADR 0002](0002-local-cli-providers.md) and
[ADR 0088](0088-wire-compression.md) as they are.

## Context

ADR 0150 took the direct path from 3.7 to 2.5 s to the welcome on 3g-slow (400 kbit/s down,
400 ms round trip, 2% loss). The relay path did not move (2,277 ms before, 2,295 ms after), and a
returning client spends most of its 1.7 to 1.8 s to confirmed data before the welcome. The
relay attempt dials with its own credential, so it gets no handed ticket, and its handshake is
untouched by ADR 0150.

### What a relay connect waits for today

From the code (`packages/client/src/portable-relay.ts`, `packages/client/src/relay-route.ts`,
`apps/relay/src/host.ts`, `apps/cloud/src/relay-object.ts`, `apps/daemon/src/files-relay.ts`):

1. **Account grant** (account devices only, hosted relay): `POST /v1/grants` to ace cloud over
   its own HTTPS connection, before the dial, because the grant is the upgrade's subprotocol
   (`ace.grant.<token>`). Cached in memory for its life since ADR 0150, so a reconnect in the
   same session skips it; a relaunch and a first connect pay it.
2. **Relay socket**: TCP, TLS 1.3 (`wss://`), then the WebSocket upgrade to `/client?hostId=…`.
3. **Daemon join**: the daemon keeps one standing, registered control socket at the relay
   (`/host`, its own Noise session). It does not keep a stream socket: when a client arrives,
   the relay offers a ticket over the control session and the daemon dials a fresh `/join`
   (TCP, TLS, upgrade on its own link). The relay then sends the client a one-byte readiness
   marker. The client must not send before it: early client data closes it
   (`RelayRoutes.premature`, both relays).
4. **Noise XX** on the stream (`ace daemon relay stream v1`, empty payloads): the client sends
   `e`; the daemon answers `e, ee, s, es`, and the client checks `s` against the pinned host id
   (the host id is the base32 of the daemon's whole X25519 static key); the client sends
   `s, se`. The client's static key is new for every attempt (`ephemeralRelayKeys`), so Noise
   authenticates only the daemon; the client proves itself in its hello.
5. **Hello and welcome**: the hello (with the device token, a ticket or the grant) goes in the
   same flight as the third Noise message; the daemon checks it (`relayHello`), hands the
   channel to its main socket handler, and answers with a credit fragment and the welcome.

Measured with `apps/daemon/bench/relay-connect.ts` (added with this ADR): a real daemon, the
self-hosted relay on loopback, the real client with the web app's options on a paired device's
relay route, and the link shaper between the phone and the relay, 7 runs per case. Times are
from the client dialling the relay socket; the median is the loss-free case, and 2 to 3 runs in
7 per case pay one 600 ms loss stall at a random step.

| Step (phone side, 3g-slow)                      |  Cold | Reconnect | Relaunch | Round trips |
| ----------------------------------------------- | ----: | --------: | -------: | ----------- |
| Socket open (TCP, upgrade; no TLS in the bench) |   820 |       820 |      820 | 2           |
| Readiness marker (daemon joined on loopback)    |   820 |       820 |      820 | 0 here      |
| Noise message 1 sent                            |   820 |       820 |      820 |             |
| Noise message 2 received                        | 1,227 |     1,228 |    1,228 | 1           |
| Noise message 3 and hello sent (one flight)     | 1,228 |     1,229 |    1,229 |             |
| Welcome (after a 21-byte credit fragment)       | 1,655 |     1,706 |    1,655 | 1           |
| Client flights before the welcome               |     3 |         3 |        3 |             |

The three cases are the same on the relay path: nothing a returning client holds shortens the
handshake. What the bench leaves out, and a phone on ace cloud pays on top (estimated, with
the Mac 40 ms from Cloudflare's edge):

| Not in the bench                                                                    |                      Cost on 3g-slow |
| ----------------------------------------------------------------------------------- | -----------------------------------: |
| TLS 1.3 to the relay                                                                |                +1 round trip, 400 ms |
| The daemon's `/join` dial (offer, TCP, TLS, upgrade on its link), before the marker |   about 4 daemon round trips, 160 ms |
| The daemon's leg of Noise message 2 and of the welcome                              |    about 2 daemon round trips, 80 ms |
| Grant fetch (first connect, relaunch; not a reconnect)                              | TCP, TLS, POST: 3 round trips, 1.2 s |

So on ace cloud a returning client in the same session waits about 2.3 s to the welcome before
any loss (3 round trips to open, the join, 2 round trips of handshake and hello), and a relaunch
of an account device about 3.5 s.

## Decision (proposed): three steps, each shippable alone

Every step is negotiated: a client uses it only when it knows the other end supports it, and
anything else gets today's behaviour. None of them changes what the relay can see: it still
forwards ciphertext and public handshake values, and it still cannot read or forge daemon
traffic. Provider credentials never enter this path (ADR 0002).

| Step                                   |  Saves on ace cloud, 3g-slow (estimate) | Cost to build                                                                                                                                                               | Cost of getting it wrong                                                                        |
| -------------------------------------- | --------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. Relay holds one early frame         | about 160 ms (more on fast phone links) | small: both relays' routing, pending budgets, a client flag                                                                                                                 | availability: relay or object memory pressure; no data exposure                                 |
| 2. Noise NK, allowlisted first payload |                            about 440 ms | large: NK and test vectors, an early payload type, a confirmation phase, replay suppression, pre-confirmation budgets, a subscribe audit, handed tickets on relayed sockets | security: unauthorised reads, replayed work, a burned ticket; the step that needs the most care |
| 3. First message in the upgrade        |                            about 400 ms | medium: header encoding in both relays, redaction everywhere, bounded retry                                                                                                 | exposure of ciphertext and metadata in logs; failed upgrades (availability)                     |

### Step 1: the relay holds one early client frame (saves the join wait)

A client may send its first Noise message as soon as the socket opens instead of waiting for the
readiness marker. The relay holds that one frame until the daemon joins and forwards it right
after pairing; the marker still goes to the client as today.

- **Negotiation, with no extra round trip.** A client that supports it offers one more
  subprotocol, `ace.early.1`, beside the grant. A relay that supports it and has reserved room
  for the frame (below) echoes `ace.early.1` instead of the grant entry (a server echoes exactly
  one of the offered entries; it still reads the grant from the offered list). The client
  learns the answer from the upgrade response itself, at the moment its socket opens: echoed,
  it sends its first message at once; not echoed (an older relay, or no room), it waits for the
  marker as today. An older relay closes an early sender, so a client never sends early without
  the echo, and remembers nothing between connections.
- **One frame, bounded before allocation.** At most one frame per waiting client, at most
  64 KiB (the Noise message limit), and only within aggregate budgets the relay checks before
  it accepts the upgrade, not when the frame arrives: per host (one ace cloud object holds all
  of one daemon's sockets) at most 16 waiting clients with a held frame and 1 MiB held; per
  relay process (Node) at most 256 and 16 MiB. A relay over a budget does not offer early
  sending for that upgrade, and the client waits for the marker. A frame larger than the
  reservation, or a second frame before pairing, closes that client as today.
- **Bound to its client.** The held frame is keyed to the exact client socket, the ticket
  offered for it and the host registration generation that received the offer. It is forwarded
  only to the `/join` that carries that ticket under that generation, and cleared on ticket
  expiry, on host replacement (a newer registration), and on the client's disconnect.
- **Hibernation.** ace cloud's object can be evicted between events while sockets stay open;
  memory goes, and a 64 KiB frame does not fit a socket attachment (Cloudflare caps
  `serializeAttachment` at 2,048 bytes). The relay does not try to keep the frame. Each waiting
  client's attachment records its early state with its ticket and the host registration
  generation: `reserved` (room reserved, no frame yet), `held` (a frame received and kept in
  memory), or nothing (an ordinary marker-path client). When the object wakes, before it admits
  any new socket, it rebuilds the reservation counts from the `reserved` and `held` attachments,
  and every `held` client whose frame is no longer in memory is closed with a dedicated close
  code and its reservation released. That client retries once at once without early sending
  (the marker path). A `reserved` client whose frame arrives after a wake is held as usual.
  Durable Object storage would keep the frame, but costs a write per connect for a case that is
  rare while a join is seconds away.
- **Misrouting.** A frame forwarded to the wrong daemon fails there: an NK first message is
  encrypted to the pinned daemon's static key and fails decryption at any other; an XX first
  message leads to a responder key that fails the client's pin check.
- **Saves** the daemon's `/join` dial on the phone's path whenever it is shorter than the half
  round trip the first message takes to reach the relay (on 3g-slow, about 160 ms against
  200 ms: hidden). Nothing in the bench, which joins on loopback.

### Step 2: a one-round-trip handshake for a client that knows the daemon

A client that was welcomed by a daemon before, and was told by that welcome that the daemon
takes it, opens the stream with Noise **NK**: `-> e, es` carrying an allowlisted early payload;
`<- e, ee` carrying the daemon's answer. The prologue is `ace daemon relay stream v2 nk`. The
daemon tells the patterns apart by the first message's length (an XX first message is exactly
32 bytes) and the prologue. First contact, and a daemon that does not announce it, use XX.

NK, not IK: the client's static key is thrown away after every attempt today, so IK would send a
meaningless key. NK gives what XX gives now at the Noise level (the daemon authenticated against
its pinned key, the client authenticated by its credential inside) with one round trip fewer.

#### The early payload, field by field

The first message carries a dedicated message, `hello.early`, not today's hello. Today's hello
also checks and remembers a machine code, links a paired identity to an account device, folds
an install's records together, holds a grant, and enrols the device for notifications; none of
that may run on a message that might be a replay. Allowed, and nothing else:

| Field                                            | Meaning                                                                                 | Why it is safe before confirmation                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `protocolVersion`                                | 1                                                                                       | no state                                                                                     |
| `deviceId`                                       | the device it claims to be                                                              | checked against the credential; nothing recorded                                             |
| `ticket` or `grant` (exactly one)                | a one-use ticket the daemon handed in its last welcome, or the account device grant     | short-lived; a ticket is one-use; the grant is already offered to the relay as a subprotocol |
| `trims`, `framing`, `compression`, `flowControl` | how the daemon may shape this session's frames                                          | per-session negotiation, nothing kept                                                        |
| `subscribes`                                     | at most 4 thread subscribes and 2 sidebar windows, each with its cursor or resume point | read only, under the caps below                                                              |

Excluded until the client has confirmed (below): `token` (a paired device's long-lived
credential never travels in the first message), `machineCode`, `link`, `installId` (it folds
records), `channel` (dedicated channels keep XX), `nextTicket` (issuing a ticket uses the
device's quota), `mediaTicket`, presence, notification preferences, read markers, settings, and
every command or outbox replay.

**Confirmation.** The client's first transport message after the daemon's answer (`hello.confirm`)
proves it holds the ephemeral private key: only the holder of `e` can derive the keys that
encrypt it.

- **Order on the daemon's side.** The handshake answer (`<- e, ee`) goes first, before any
  credit fragment, the welcome or early responses, and nothing bulk is queued ahead of it.
- **When the client sends it.** As soon as it has authenticated the daemon's answer: it does
  not wait for the welcome, for a subscribe to complete or for application credit (it is sent
  outside the flow window, as credit fragments are, and is a few hundred bytes).
- **No round trip added.** The daemon doesn't acknowledge it before the welcome; the welcome
  and early responses ride behind the answer, so a confirmation that takes a round trip to
  arrive delays nothing the client is waiting for. At 400 kbit/s, 256 KiB of early output takes
  about 5.2 s to download, so the deadline counts from the answer, which is sent first, and the
  confirmation travels upstream, never behind that output.
- **Deadline test.** A test holds the 5-second deadline on links with a 0.4 to 1 s round trip
  and loss stalls: a legitimate client confirms in time. It carries the excluded hello fields the client needs (`installId`, `link`,
  `nextTicket`; a `machineCode` only when the daemon asked). Only then does the daemon run what
  today's hello runs (recognising and folding the install, linking, admitting a machine code,
  holding the grant, enrolling notifications, issuing the next ticket) and lift the limits below.
  Commands, the outbox replay and read markers wait for it, as they wait for the welcome on the
  direct path.

#### Replays and work before confirmation

A recorder (the relay, or anyone on its path) can send a captured first message again. The
session that opens is useless to it: the daemon's answer and everything after are keyed by
`ee`, which needs the client's ephemeral private key, so responses stay on the session keyed to
that message's ephemeral key and a recorder reads none of them. What a replay can still do, and
what bounds it:

- **Win the race for a ticket.** An early copy can consume the legitimate ticket and make the
  real attempt fail. Tickets are consumed atomically (one synchronous check-and-delete in the
  daemon's pool, as today), so exactly one attempt gets through. Recovery is a flow, not an
  error:
  1. the real NK attempt is refused;
  2. the client makes one immediate attempt with XX, its pinned key and its device token (today's
     path, with forward secrecy for the token);
  3. that welcome hands a fresh ticket for the next NK attempt, and announces NK again (every
     welcome from a daemon that takes NK announces it, over either pattern);
  4. the client counts NK failures per host in a row: a refused or failed NK attempt adds one,
     an NK attempt that reaches its welcome resets the count to zero, and XX attempts don't
     change it;
  5. at two in a row, the client uses XX for that host and tries NK again only after a wait
     that starts at 10 minutes and doubles up to 24 hours with each further failed try; one
     success resets the count and the wait.

  A relay that keeps burning tickets can therefore hold a client on the slow path (XX, about
  440 ms more per connect on 3g-slow) for as long as it keeps doing so. That is a performance
  and availability downgrade, not a confidentiality break, and a malicious relay can always deny
  service outright by dropping frames.

- **Repeat work.** The daemon keeps the ephemeral key (`e`, 32 bytes) of every NK first message
  it accepted in the last 5 minutes (one grant lifetime), at most 4,096 entries (128 KiB), and
  refuses an identical one. When the set is full it refuses NK first messages (the clients fall
  back to XX) rather than forgetting entries early. The set is memory only; a daemon restart
  empties it, which lets a grant's first message be replayed once more within that grant's
  remaining life, into a session nobody can use and under the limits below.
- **Occupy slots and repeat work.** Session counts alone bound concurrency, not CPU, memory or
  repeated work: fresh grant-bearing attempts could keep refilling slots, and invalid attempts
  never reach an authenticated limit at all. So the daemon enforces, before it acquires
  anything for an NK first message:
  - **Before authentication**, for every NK first message, valid or not: at most 20 per second
    per daemon (burst 40) and 2 per second per claimed device id (burst 4). The work done for
    one (decryption, one ticket lookup or one grant signature check, and the uniform refusal)
    is bounded and the same for every outcome. Over the rate, the attempt is refused without
    that work, and the client uses XX.
  - **Admission, once authenticated**, before confirmation: at most 2 unconfirmed sessions per
    device and 32 per daemon (as before), and at most 6 NK attempts per device per minute;
    beyond that the client uses XX.
  - **Memory and replay work**, checked against each thread's stored size before anything is
    acquired: at most 8 MiB of projections and snapshots per unconfirmed session, 64 MiB
    across all of them, and at most 2,000 replayed events per session. A subscribe that would
    go over waits for confirmation.
  - **Output**: at most 256 KiB queued or sent per unconfirmed session, counting what waits in
    the session's send queue, not only what has left. The rest waits for confirmation.
  - **Deadline**: a session must confirm within 5 seconds of the daemon's answer, or it is
    closed and everything it acquired released (projections, listeners, timers, queued output).
  - **Tests** must exhaust each of these (a flood of invalid attempts, of fresh grant-bearing
    attempts, and of sessions that never confirm) and show that confirmed sessions keep their
    latency and that everything is released.
- **Learn validity from the answer.** Every refusal of an NK first message (unknown device,
  spent or unknown ticket, expired or wrong grant, a full suppression set) is answered the same
  way: the same padded size and after the same work, so its size and timing don't tell a valid
  device from an invalid one.

#### Read subscribes before confirmation

Subscribes are not free today: they acquire projections, read or replay snapshots, register
listeners and schedule paced-replay timers. Before step 2 ships, an audit of the subscribe path
must confirm, and a test must hold, that a subscribe changes no read marker, wakes no agent and
writes nothing durable. Until the client confirms, the session may run at most the subscribes
the allowlist names, use at most 256 KiB of response bytes (the rest waits for confirmation),
count against the per-device and daemon-wide limits above for CPU and projection memory, and is
cleaned up (unsubscribed, projections released, timers cancelled) at once when it closes or
misses its deadline. Encrypted response lengths and timing still tell an observer roughly how
large the answers are, as they do today after an XX handshake.

#### Secrecy and lifecycle

- **What a stolen static key reveals.** The early payload is encrypted under `es` only. Anyone
  who records it and later steals the daemon's static key can read the whole allowed payload:
  the ticket or grant, the device id, thread ids, cursors and the session options. XX protects
  its hello against that. Everything after the first message keeps forward secrecy: it is keyed
  by fresh ephemerals on both sides, which are erased after the handshake.
- **Tickets** keep ADR 0150's rules: 60 s, memory only on both ends, one-use, bound to the
  device and its credential generation, counted against the device's quota. Added for the relay:
  bound to the daemon's identity and the static key that issued it (a key change invalidates
  every ticket); invalidated by a daemon restart (the pool is in memory) and by revoking the
  device (`TicketPool.revoke`, as today, so a revoked paired device's outstanding tickets are
  refused); expiry measured on the daemon's clock, with the client presenting a ticket only
  while it is fresh by both its monotonic and its wall clock (ADR 0150); each device and each app
  instance holds its own latest ticket, so concurrent devices never share one.
- **Account revocation** keeps today's delay: a grant already issued stays usable for up to its
  5-minute lifetime, after which the device can't get another.

#### Downgrade and the pin

The capability (`relayHandshakes: ["nk1"]`) arrives in a welcome, which is authenticated by the
pinned key, and the client stores it with that key: a different key carries no capability. An
attacker can force a fallback to XX (by dropping or corrupting NK attempts), which costs
availability only. A fallback never replaces a pin: an XX answer whose key does not match the pin
fails as today, and a changed key requires trusted re-pairing.

#### What stays the same

The hello and subscribes ride in a Noise payload, not a JSON message on the channel, so ADR 0088
is untouched: nothing in the first message is compressed. After the handshake, NK and XX both
end in Noise `Split()` with two `CipherState`s, so the 120-byte block the channel hands to
ace-media keeps its layout, offsets and meaning (send key, receive key, both next nonces, frame
counts, flow state, CRC; `docs/media/plan.md`, "Key hand-over"). Its bytes are different for
NK and XX, as they are for any two sessions. Nothing depends on them matching: the daemon writes
the block from the live cipher states (`apps/daemon/src/media-relay/handover.ts`), and
`media-noise` installs the keys and nonces it is given and never handshakes.

### Step 3: the first message in the upgrade request

With steps 1 and 2, the client can put the NK first message in the upgrade itself, as a
subprotocol entry (`ace.n1.<base64url>`; browsers can set only the URL and the subprotocols of a
WebSocket). The relay takes it as the client's first frame and forwards it when the daemon joins;
the daemon's answer comes back right behind the `101`.

- **Exposure.** This adds no plaintext the relay can read, but it puts ciphertext and the
  ephemeral key in a header, where proxies, a CDN, error reports and metrics may log or keep
  headers. The header, like the grant and join tickets, is redacted everywhere ace controls (the
  relay's logs, the Worker, error reporting, metrics), and the self-hosted relay's docs say to
  disable header logging in a proxy in front of it.
- **Size.** The entry is at most 4 KiB and the whole `Sec-WebSocket-Protocol` header at most
  8 KiB, below Cloudflare's request header limits and common proxy defaults. A client whose first
  message does not fit sends it as a frame after the open.
- **One subprotocol.** A server echoes exactly one of the offered subprotocols. The hosted relay
  echoes the grant entry today, so the new features can't each be signalled by their own echo.
  A new relay instead echoes one offered entry, `ace.v2`, meaning "early frames held, and the
  header's first message taken"; it still reads the grant from the offered list. An older relay
  echoes the grant (or nothing, self-hosted), and the client then sends the first message as a
  frame after the open, or waits for the marker.
- **Reservation first.** The relay reserves room for the frame (step 1's budgets) atomically
  before it accepts, decodes or keeps the header's message. With no room, it echoes neither
  `ace.v2` nor `ace.early.1` (the grant, or nothing), discards the header entry unread, and
  never forwards it; the absent echo is the client's guarantee of that. The client then sends
  its first message as a frame after the marker (today's path, in the same connection): one
  fallback, no retry.
- **Exactly once.** When `ace.v2` is echoed, the relay forwards the header's message exactly once
  and the client never sends it again as a frame; when it is not, the client sends it once as a
  frame. A relay that sees both closes the client.
- **Rejected before the 101.** An echo cannot rescue an upgrade the relay or a proxy refused for
  its size: the client retries once at once without the entry (step 1's path), and a second
  refusal goes to the ordinary reconnect backoff.

### Not proposed now

- **Resumption across a short drop** (Noise `NKpsk0` with a key from the last session): it saves
  no round trip over step 2, since the answer still needs `ee` for forward secrecy, and it adds a
  resumption secret held in memory on both ends, wiped on revocation and capped at a few minutes.
- **Sending the hello with the last XX message**: it already goes in the same flight (the bench
  counts 3 client flights before the welcome).
- **A standing spare `/join` socket** per daemon: it removes the join wait too, but step 1 hides
  that wait on 3G at no standing cost. Worth reconsidering for fast phone links.

## Expected result on 3g-slow

|                                                                                                  | Bench (no TLS, loopback daemon) | ace cloud (estimate) |
| ------------------------------------------------------------------------------------------------ | ------------------------------: | -------------------: |
| Today, returning client to welcome                                                               |                        1,655 ms |       about 2,300 ms |
| After step 1                                                                                     |                        1,655 ms |       about 2,140 ms |
| After steps 1 and 2                                                                              |                  about 1,240 ms |       about 1,700 ms |
| After steps 1, 2 and 3                                                                           |                    about 840 ms |       about 1,260 ms |
| Confirmed data (welcome plus 0.25 to 0.3 s today; less with the subscribes in the first message) |                     about 1.1 s |          about 1.5 s |

**Bottom line.** With all three steps, a returning client's welcome on the hosted relay on
3g-slow is about 1.26 s and its confirmed data about 1.5 s. It can't get under about 1.2 s this
way: a fresh TCP and TLS connection alone costs 2 round trips (about 800 ms) before the upgrade.
Getting under 1 s needs a connection that survives the drop. An account device's relaunch also
still pays the grant fetch (about 1.2 s) before the dial.

**The alternative: a connection that survives the drop.** A transport over QUIC (HTTP/3, through
WebTransport where the platform has it) keeps its connection across a change of network
(connection migration) and can send data in its first flight on a reconnect (0-RTT resumption).
For a returning client that would remove TCP and TLS from the reconnect, about 800 ms on
3g-slow, on top of whatever handshake runs inside it; with step 2's NK inside it, a welcome about
one round trip after a reconnect, about 0.45 s, and confirmed data under 1 s. It would take a
second transport beside WebSocket on every client (the browser, the iOS app's networking, the
daemon) and on both relays, support for it on ace cloud's platform (not available to Workers
today, so it is research, not a plan), and the same care for 0-RTT replay at the TLS layer that
step 2 takes at the Noise layer. Steps 1 to 3 and this are not exclusive: step 2's handshake and
its rules carry over unchanged.

## Consequences

- Each step ships alone and falls back to today's behaviour against older relays, daemons and
  clients.
- Step 2 changes the security analysis of the first message, as stated above; steps 1 and 3
  change when and how the relay receives ciphertext it already forwards.
- The relay contract in [docs/relay](../relay/README.md) gains the held early frame and its
  budgets (step 1) and the `ace.v2` subprotocol (step 3), for both relays.

## Verification

- `apps/daemon/bench/relay-connect.ts` reports each step above; rerun after each step.
- Step 1: both relays hold, forward and clear the early frame (pairing, expiry, replacement,
  disconnect), enforce the per-host and per-relay budgets before allocation, and an old client
  against a new relay and a new client against an old relay keep working. ace cloud's object
  evicted before the frame arrives keeps the reservation and holds the frame after waking;
  evicted after it arrives, the client is closed with the dedicated code and connects again
  without early sending.
- Step 2: Noise NK test vectors; an early payload with any excluded field refused; nothing in
  today's hello side effects runs before `hello.confirm`; a replayed first message refused
  (suppression, spent ticket) or confined (grant, under the pre-confirmation limits); the burned
  ticket recovery flow; refusals of the same size and timing whatever the reason; the subscribe
  audit's test; the 120-byte block written with the same layout after NK and after XX.
- Step 3: the header redacted in every log and report ace controls; an oversized or refused
  upgrade retried once without it; the first message delivered exactly once.
