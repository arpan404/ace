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

## Decision (proposed): four steps, each shippable alone

Every step is negotiated: a client uses it only when it knows the other end supports it, and
anything else gets today's behaviour. Nothing here changes what the relay can see: it still
forwards ciphertext and public handshake values, and it still cannot read or forge daemon
traffic. Nothing here touches provider credentials (ADR 0002), which never enter this path.
The transport cipher states after the handshake are the same two `CipherState`s from Noise
`Split()`, so the 120-byte key block the channel hands to ace-media stays byte-for-byte what it
is today; the change is in the daemon and the client, not in the media crate.

### Step 1: the relay holds one early client frame (saves the join wait, about 160 ms)

A client may send its first Noise message as soon as the socket opens instead of waiting for
the readiness marker. The relay holds that one frame (at most 64 KiB, the Noise message limit)
until the daemon joins, then forwards it right after pairing; the marker still goes to the
client as today. Both relays (Node and ace cloud) implement it; a relay that does tells the
client by accepting a `ace.early.1` subprotocol in the upgrade response, and a client that does
not see it waits for the marker as now.

- Saves: the daemon's `/join` dial no longer sits on the phone's critical path when it is
  shorter than the half round trip the first message takes to reach the relay (on 3g-slow,
  160 ms against 200 ms: hidden). Nothing in the bench, which joins on loopback.
- Costs: one buffered frame per waiting client, released on pairing or at the 10 s ticket
  expiry; within the Durable Object's memory and admission limits already in place.
- Risks: a client that floods before pairing is refused as today (one frame only). Old relays:
  no change in behaviour, since the client only sends early after the subprotocol is accepted.

### Step 2: a one-round-trip handshake for a client that knows the daemon (saves 1 round trip)

A client that has been welcomed by a daemon before, and was told by that welcome that the
daemon takes it (`relayHandshakes: ["nk1"]` in the welcome, kept with the machine like its
other non-secret facts), opens the stream with Noise **NK** instead of XX: `-> e, es` with the
hello (and its read subscribes, as the direct path sends them since ADR 0150) as the first
message's payload; `<- e, ee`, with the daemon's first frames behind it. The prologue is
`ace daemon relay stream v2 nk`. The daemon tells the two apart by the first message's length
(an XX first message is exactly 32 bytes; an NK one carries a payload) and its prologue. First
contact, a key that changed (the pinned id no longer matches) and a daemon that doesn't
advertise it use XX, as today.

NK, not IK: the client's static key is thrown away after every attempt today, so IK would only
send a meaningless key. NK gives exactly what XX gives now at the Noise level (the daemon
authenticated against its pinned key, the client authenticated by its hello) with one round
trip fewer. IK becomes the right pattern only if devices someday keep a static key of their own.

What NK gives up against XX, and what the first message may therefore carry:

- **Initiator identity hiding**: nothing is lost; the client has no lasting Noise identity in
  either pattern, and its device id travels in the hello in both.
- **Forward secrecy of the first message**: its payload is encrypted under `es` only (the
  daemon's static key and the client's ephemeral). Anyone who records it and later steals the
  daemon's static key can read it. So it carries no long-lived secret: never the paired
  device token. A paired device presents a **one-use ticket the daemon handed it in its last
  welcome** (ADR 0150's handed ticket, extended to relayed sockets for clients that ask); an
  account device presents its device grant, which is short-lived (5 minutes) and already
  offered to the relay as the upgrade's subprotocol, so it reveals nothing the relay does not
  see today. A client with neither (no handed ticket, or one too close to expiry) uses XX.
  Thread ids and cursors in the read subscribes are the only other content.
- **Replay of the first message**: anyone who can capture it (the relay) can send it to the
  daemon again. The replayed session is useless to them: everything after the first message is
  keyed by `ee`, which needs the client's ephemeral private key. What a replay can still do is
  make the daemon process the payload again: a handed ticket is one-use, so a replay is
  refused; a grant replayed within its 5 minutes opens a session nobody can read or write and
  starts read subscribes whose answers nobody can decrypt. So the first message must carry
  nothing that acts: no command, no outbox replay, no read-marker write, no setting. Those wait
  for the welcome, as on the direct path. A replay is no more than a denial of service, which
  the relay can already do by dropping frames.
- **Message 2 and everything after it** keep full forward secrecy (`ee`), as in XX.
- **Downgrade**: the relay can't push the client from NK to XX without the attempt failing,
  and XX is the current, accepted security level. A failed NK attempt falls back to XX once,
  and NK is tried again only after a welcome advertises it again; no loop.

The hello rides in a Noise payload, not a JSON message on the channel, so ADR 0088 is untouched:
nothing in it is compressed.

- Saves: one phone round trip and one daemon round trip, about 440 ms on 3g-slow
  (bench: 1,655 to about 1,240 ms).
- Costs: an NK state machine beside `NoiseXX` in `packages/secure-channel`, with test vectors;
  the daemon's relay host reading the hello from the first message; the welcome advertising
  `nk1`; handed tickets for relayed sockets that ask.

### Step 3: the first message in the upgrade request (saves 1 more round trip)

With steps 1 and 2, the client can put the NK first message in the upgrade itself, as a second
subprotocol entry `ace.n1.<base64url>` beside the grant (browsers can set only the URL and
subprotocols on a WebSocket). The relay takes it as the client's first frame and forwards it
when the daemon joins; the daemon's second message and welcome come back right behind the
`101`. A relay that does not echo `ace.n1` did not take it, and the client sends the first
message as a frame after the open (step 1's path).

- Saves: the round trip between the socket opening and the first message, about 400 ms
  (bench: about 1,240 to about 840 ms, the welcome arriving with the open).
- Costs: the first message must fit a header (hello and read subscribes, about 1 to 2 KB as
  base64url); a client with a larger one sends it after the open. The relay must not log the
  header, as it already must not log the grant or join tickets.
- Risks: proxies in front of a self-hosted relay that cap header size; the echo check makes
  that a fallback, not a failure.

### Step 4 (not proposed now): resumption across a short drop

A pre-shared key from the last session (Noise `NKpsk0`) would let a client resume without any
credential in the first message. It saves no round trip over step 2 (the reply still needs
`ee` for forward secrecy), and it needs a resumption secret kept in memory on both ends, wiped
on revocation and capped at a few minutes. Step 2 with a handed ticket gets the same time with
less key handling, so resumption waits until something needs it.

### Not proposed

- **Sending the hello with the last XX message**: it already goes in the same flight (the
  bench counts 3 client flights before the welcome); folding it into the Noise payload saves
  bytes, not a round trip.
- **A standing spare `/join` socket** per daemon: it removes the join wait too, but step 1 hides
  that wait on 3G for no standing cost. It is worth reconsidering for fast phone links, where
  the daemon's dial is longer than the phone's half round trip.

## Expected result on 3g-slow

|                                                                                                    | Bench (no TLS, loopback daemon) | ace cloud (estimated) |
| -------------------------------------------------------------------------------------------------- | ------------------------------: | --------------------: |
| Today, returning client to welcome                                                                 |                        1,655 ms |        about 2,300 ms |
| After step 1                                                                                       |                        1,655 ms |        about 2,140 ms |
| After steps 1 and 2                                                                                |                  about 1,240 ms |        about 1,700 ms |
| After steps 1, 2 and 3                                                                             |                    about 840 ms |        about 1,260 ms |
| Confirmed data (welcome plus 0.25 to 0.3 s today; less when the subscribes ride the first message) |                     about 1.1 s |           about 1.5 s |

About 1 s to confirmed data for a returning client is reachable in the bench's terms with all
three steps, and not on ace cloud: a fresh TCP and TLS connection costs 2 round trips (800 ms)
before the upgrade, so the welcome can't arrive before about 1.2 s. Getting under that needs a
socket that outlives the drop (WebSocket over an HTTP/2 or HTTP/3 connection already open, or
TLS early data), which is outside this ADR. An account device's relaunch also still pays the
grant fetch (1.2 s) before the dial; issuing the grant over the same connection as the relay
socket would be the follow-up for that.

## Consequences

- Each step ships alone and falls back to today's behaviour against older relays, daemons and
  clients.
- Step 2 changes the security analysis of the first message, as stated above; steps 1 and 3
  change only when ciphertext the relay already forwards may arrive.
- The relay contract in [docs/relay](../relay/README.md) gains the early frame (step 1) and the
  `ace.n1` subprotocol (step 3), for both relays.

## Verification

- `apps/daemon/bench/relay-connect.ts` reports each step above; rerun after each step.
- Step 2: Noise NK test vectors, a replayed first message refused (handed ticket) or useless
  (grant), a first message with a command refused, XX fallback when the daemon doesn't advertise
  NK, and the 120-byte key block identical after NK and XX for the same keys.
- Step 1 and 3: both relays hold, forward and expire the early frame, and an old client against
  a new relay and a new client against an old relay keep working.
