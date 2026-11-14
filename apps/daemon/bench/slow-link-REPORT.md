# Slow-link baseline (3G)

The numbers below are the baseline for changes to the connection handshake, the wire payloads,
the relay and daemon-to-daemon calls. Measured on 2026-11-14 at `2ea2f91715`: this harness
merged with main at `1c083958d3`, on the shared 16-core Mac. How to run a case is in
[README.md](README.md#slow-links-3g). Raw results: [slow-link-results.json](slow-link-results.json),
[machine-link-results.json](machine-link-results.json) and
[web-slow-link-results.json](web-slow-link-results.json); the tables are generated from them.

## What changed since the first baseline (`006bebcf8b`)

The first baseline was taken with a shaper that gave every connection its own full-rate link
and ignored a receiver's backpressure. That baseline was not a 3G measurement wherever a client
used parallel connections. The shaper now puts every connection through one shared link per
direction (served in turn, segment by segment), stops reading from a sender while a connection
holds more than 64 KiB, honours a receiver's `drain`, counts bytes only once written through,
and forwards half-closes. Two bench fixes changed what is measured too. To attribute each
change, the merged tree was also run with the old shaper minutes apart from the new one (A/B
below). Main's 59 merged commits touched no client, wire, relay or machine-call code (media,
devices, screen and one setting).

- **Web app, cold first visit, 3g-slow: 20.3 s → 24.1 and 24.5 s (+19 to +21%).** This is the
  P1 fix. Chromium loads the app over several parallel connections, which shared 6 × 400 kbit/s
  before and now share one 400 kbit/s link. A/B on the same tree: 20.8 s old shaper, 24.2 s new.
  3g-fast: 12.7 → 13.7 s (+8%). Bytes are unchanged (758 KB before first content).
- **Web app, warm visit: the link now reads 2 KiB instead of 14 KiB, at 1.8–2.4 s (was 1.6 s).**
  The link counts were read after Playwright's waits instead of at first content (item 5); they
  now cover only up to the first message. The warm visit also needed the cold page to finish
  loading before closing: with the slower shared link it otherwise ran anywhere from 1.9 to
  7.2 s with 132 KB refetched.
- **Direct path round trips: welcome 7 → 8, sidebar 8 → 9, kept-thread confirmation 9 → 11, catch-up
  8 → 9.** Same times (3,716 vs 3,725 ms welcome; A/B 3,731 new vs 3,915 old). The added flights
  are the TLS close alerts on the socket-ticket HTTPS connection: the daemon answers and closes,
  the client answers with its close. The old shaper tore the connection down at the first close
  and dropped those bytes; with half-close forwarded they are delivered and counted. They are
  real traffic but not a wait.
- **Daemon-to-daemon, child finished → first answer reporting it: 5,001 → 2,266 ms (3g-slow),
  1,123 → 2,030 ms (3g-fast), 188 → 149 ms (lan).** The old figure timed the first status request
  _started_ after the finish, using two processes' clocks; it now times the first answer that
  reports the child finished, whenever its request started (item 6). It is one sample per
  profile and falls anywhere between one call and one poll interval plus one call (about 1.0 to
  2.8 s on 3g-slow), so read it as a range, not a point.
- **Unchanged within noise:** every slow-link row that uses one connection at a time (thread
  first content, approvals, sidebar time), each status call (3 RT, about 5.1 KiB, 1.36 s on
  3g-slow) and the call rates (25/min running, 6/min settled on 3g-slow). The client multiplexes
  everything over one WebSocket, so a shared link changes nothing for it.
- **Noise worth knowing:** catch-up bytes vary between runs regardless of shaper (direct 3g-slow
  13.1, 16.6, 16.9, 22.7 KiB across four runs; A/B on one tree: 16.9 old, 16.6 new). The relay's
  kept-thread confirmation varied 2.07–2.69 s. The approval behind a snapshot varies with how much
  of the snapshot is still queued when it is sent.

Old → new on 3g-slow, daemon to client (time · round trips · KiB down):

| 3g-slow                                   | direct: old → new                           | relay: old → new                            |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Connect → welcome                         | 3725 → 3716 ms · 7 → 8 RT · 6.0 → 6.0 KiB   | 2294 → 2277 ms · 4 → 4 RT · 0.4 → 0.4 KiB   |
| Connect → first sidebar rows              | 4229 → 4228 ms · 8 → 9 RT · 9.8 → 9.8 KiB   | 2791 → 2773 ms · 5 → 5 RT · 4.2 → 4.2 KiB   |
| Small thread (4 items), first content     | 467 → 476 ms · 1 → 1 RT · 2.4 → 2.4 KiB     | 466 → 466 ms · 1 → 1 RT · 2.5 → 2.5 KiB     |
| Typical thread (123 items), first content | 1106 → 1107 ms · 1 → 1 RT · 33.6 → 33.5 KiB | 1107 → 1103 ms · 1 → 1 RT · 33.5 → 33.5 KiB |
| Large thread (1,500 items), first content | 1620 → 1624 ms · 1 → 1 RT · 58.4 → 58.5 KiB | 1612 → 1616 ms · 1 → 1 RT · 60.5 → 60.6 KiB |
| Kept thread, painted from disk            | 4 → 6 ms · 0 → 0 RT · 0.0 → 0.0 KiB         | 3 → 3 ms · 0 → 0 RT · 0.0 → 0.0 KiB         |
| Kept thread, connect → confirmed          | 3518 → 3552 ms · 9 → 11 RT · 6.2 → 6.2 KiB  | 2689 → 2066 ms · 6 → 5 RT · 0.5 → 0.5 KiB   |
| Resume after a 2,000-delta turn           | 4263 → 4465 ms · 8 → 9 RT · 13.1 → 16.9 KiB | 2829 → 2736 ms · 6 → 5 RT · 8.2 → 7.8 KiB   |
| Approval delay, idle                      | 419 → 392 ms                                | 372 → 371 ms                                |
| Approval delay, behind the large snapshot | 1705 → 1792 ms                              | 1805 → 1896 ms                              |

Daemon to daemon, old → new:

|                                            | 3g-slow old → new                                     | 3g-fast old → new                                   | lan old → new                                   |
| ------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| delegate_task                              | 1405 → 1442 ms                                        | 1042 → 1060 ms                                      | 99 → 127 ms                                     |
| One status call (median)                   | 1357 → 1361 ms · 3.1 → 3 RT · 5.2 → 5.1 KiB both ways | 948 → 958 ms · 3 → 3.1 RT · 5.1 → 5.2 KiB both ways | 10 → 10 ms · 3 → 3 RT · 5.1 → 5.1 KiB both ways |
| Status calls/min, child running            | 24 → 25                                               | 30 → 29                                             | 58 → 58                                         |
| Status calls/min, child settled            | 6 → 6                                                 | 6 → 6                                               | 6 → 6                                           |
| Child finished → first answer reporting it | 5001 → 2266 ms                                        | 1123 → 2030 ms                                      | 188 → 149 ms                                    |

Web app, old → new:

|                        | cold: old → new                                           | warm: old → new                                  |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| daemon 3g-slow (run 1) | 20281 → 24134 ms · 758 → 758 KB HTTP · link 936 → 937 KiB | 1580 → 1828 ms · 0 → 0 KB HTTP · link 14 → 2 KiB |
| daemon 3g-slow (run 2) | 20281 → 24531 ms · 758 → 758 KB HTTP · link 936 → 935 KiB | 1580 → 2416 ms · 0 → 0 KB HTTP · link 14 → 2 KiB |
| daemon 3g-fast         | 12669 → 13716 ms · 758 → 772 KB HTTP · link 932 → 931 KiB | 1132 → 1168 ms · 0 → 0 KB HTTP · link 14 → 2 KiB |
| daemon lan             | 269 → 376 ms · 1147 → 1271 KB HTTP · link 1336 → 1239 KiB | 309 → 222 ms · 93 → 0 KB HTTP · link 171 → 7 KiB |
| preview 3g-slow        | 25764 → 25780 ms · 837 → 837 KB HTTP                      | 15408 → 14855 ms · 60 → 35 KB HTTP               |

## How the link is modelled

- **Rate and delay.** One bottleneck per direction, shared by every connection through the
  shaper: segments of 1,460 bytes leave one at a time at the profile's rate, connections taking
  turns, then take half the round trip to arrive. A new connection's first byte waits one round
  trip (the TCP handshake).
- **Loss.** A proxy cannot drop bytes from a TCP stream, so loss is modelled as TCP presents it to
  an application: as delay. Each segment is independently lost with the profile's probability
  (2% on 3g-slow, 1% on 3g-fast, drawn from a seeded generator, so a run's stalls fall on the
  same segments), and a lost segment arrives one retransmission timeout late: 600 ms on 3g-slow,
  450 ms on 3g-fast. Everything after it on that connection waits behind it (TCP delivers in
  order); other connections do not. The stall is about Linux's retransmission timeout on a
  steady link (smoothed RTT + 4 × variance, 200 ms floor ≈ 1.5 RTT). Fast retransmit, which
  recovers a mid-stream loss in about one round trip, is not modelled, so long transfers are
  slightly pessimistic; the congestion window's cut after a loss is not modelled either, which
  is optimistic.
- **Backpressure.** Each connection holds at most 64 KiB per direction (about one receive window)
  across the bottleneck queue, the wire and the receiver's unread data, plus the one socket read
  that crossed the bound (up to 64 KiB on Node, 512 KiB on Bun). Past it the proxy stops reading,
  so the sender's buffers fill and its writes stall; a receiver that stops reading stops the
  proxy's writes to it.
- **Round trips are counted from observed traffic, not written by hand.** The shaper counts each
  new TCP connection and each client-to-server flight (bytes sent after hearing back) as bytes are
  written through. The tables are generated from the JSON results. Only the explanations of what
  makes up a count (for example, the ticket request before the WebSocket) are a reading of the
  traffic.

## Baseline: daemon to client (`slow-link.ts`)

The client is the real `packages/client`, paired as a phone. `direct` is the daemon's pinned TLS
listener; `relay` is a local `@ace/relay` with only the client's leg shaped. Load average
211, 351, 490 at the start.

|                                           | direct 3g-slow            | relay 3g-slow             | direct 3g-fast             | relay 3g-fast             | direct lan              | relay lan               |
| ----------------------------------------- | ------------------------- | ------------------------- | -------------------------- | ------------------------- | ----------------------- | ----------------------- |
| Connect → welcome                         | 3716 ms · 8 RT · 6.0 KiB  | 2277 ms · 4 RT · 0.4 KiB  | 2674 ms · 8 RT · 6.0 KiB   | 1722 ms · 4 RT · 0.4 KiB  | 32 ms · 8 RT · 6.0 KiB  | 70 ms · 4 RT · 0.4 KiB  |
| Connect → first sidebar rows              | 4228 ms · 9 RT · 9.8 KiB  | 2773 ms · 5 RT · 4.2 KiB  | 3015 ms · 9 RT · 9.8 KiB   | 2055 ms · 5 RT · 4.2 KiB  | 47 ms · 9 RT · 9.8 KiB  | 105 ms · 5 RT · 4.2 KiB |
| Small thread (4 items), first content     | 476 ms · 1 RT · 2.4 KiB   | 466 ms · 1 RT · 2.5 KiB   | 330 ms · 1 RT · 2.5 KiB    | 324 ms · 1 RT · 2.5 KiB   | 11 ms · 1 RT · 2.5 KiB  | 30 ms · 1 RT · 3.3 KiB  |
| Typical thread (123 items), first content | 1107 ms · 1 RT · 33.5 KiB | 1103 ms · 1 RT · 33.5 KiB | 487 ms · 1 RT · 33.6 KiB   | 488 ms · 1 RT · 33.7 KiB  | 13 ms · 1 RT · 34.4 KiB | 16 ms · 1 RT · 33.5 KiB |
| Large thread (1,500 items), first content | 1624 ms · 1 RT · 58.5 KiB | 1616 ms · 1 RT · 60.6 KiB | 628 ms · 1 RT · 58.5 KiB   | 619 ms · 1 RT · 60.1 KiB  | 20 ms · 1 RT · 59.9 KiB | 25 ms · 1 RT · 59.8 KiB |
| Kept thread, painted from disk            | 6 ms · 0 RT · 0.0 KiB     | 3 ms · 0 RT · 0.0 KiB     | 4 ms · 0 RT · 0.0 KiB      | 4 ms · 0 RT · 0.0 KiB     | 4 ms · 0 RT · 0.0 KiB   | 4 ms · 0 RT · 0.0 KiB   |
| Kept thread, connect → confirmed          | 3552 ms · 11 RT · 6.2 KiB | 2066 ms · 5 RT · 0.5 KiB  | 2510 ms · 11 RT · 10.0 KiB | 1551 ms · 5 RT · 0.5 KiB  | 49 ms · 11 RT · 6.2 KiB | 43 ms · 5 RT · 0.5 KiB  |
| Resume after a 2,000-delta turn           | 4465 ms · 9 RT · 16.9 KiB | 2736 ms · 5 RT · 7.8 KiB  | 2534 ms · 9 RT · 13.3 KiB  | 1598 ms · 5 RT · 13.0 KiB | 30 ms · 9 RT · 13.3 KiB | 29 ms · 5 RT · 8.4 KiB  |
| Approval delay, idle link                 | 392 ms                    | 371 ms                    | 200 ms                     | 189 ms                    | 20 ms                   | 19 ms                   |
| Approval delay, behind the large snapshot | 1792 ms                   | 1896 ms                   | 738 ms                     | 753 ms                    | 12 ms                   | 16 ms                   |

- **Welcome takes 8 round trips on the direct path** (3.7 s on 3g-slow): a socket ticket over its
  own HTTPS connection (TCP, TLS, request, and the TLS close noted above) before the WebSocket's
  TCP, TLS, upgrade and hello. Most of its 6 KiB is the two TLS handshakes; the relay row, with
  no TLS, is 0.4 KiB.
- **The sidebar waits one more round trip after welcome**: it is subscribed once the connection
  is ready.
- **A kept thread paints from disk in about 4 ms**, then needs the whole connection before the
  daemon confirms it (3.6 s direct on 3g-slow); the confirmation itself is small.
- **Catching up after a long streamed turn is compact** (8–17 KiB for 117 KiB of streamed text,
  as the client keeps at most 64 KiB of one message); its time is the reconnect.
- **An approval waits behind a snapshot in flight**: about 0.4 s on an idle 3g-slow link, 1.8–1.9 s
  behind the 58 KiB large-thread snapshot.

## Baseline: daemon to daemon (`machine-link.ts`)

Load average 137, 264, 431 at the start; 60-second windows; default poll interval.

|                                                         | 3g-slow                                    | 3g-fast                                     | lan                                      |
| ------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- | ---------------------------------------- |
| One status call (median)                                | 1361 ms · 3 RT · 3.0 KiB down · 2.0 KiB up | 958 ms · 3.1 RT · 3.1 KiB down · 2.1 KiB up | 10 ms · 3 RT · 3.0 KiB down · 2.0 KiB up |
| Status calls per minute, child running / settled        | 25 / 6                                     | 29 / 6                                      | 58 / 6                                   |
| Child finished → first answer reporting it (one sample) | 2266 ms                                    | 2030 ms                                     | 149 ms                                   |

- **Every status call opens a new TLS connection** (TCP, TLS, request: 3 round trips) and moves
  about 5 KiB in the two directions together.
- **While the child runs, the source polls about a second after each answer**, so the rate is
  set by the call's own time: 58 a minute on lan, 25 on 3g-slow. Once it settles, 6 a minute.

## Baseline: web app (`tools/web-perf/src/slow-link.ts`)

`daemon` is the production build served by the bench daemon's TLS listener, paired as a phone,
through the shaper, opening the typical thread. `preview` is the perf build under `vite preview`
with Chromium's emulation (no loss) and the endless agent's thread. Requests, KB and sequential
round trips are counted by Chromium before first content; `link` is everything on the shaped link
up to first content, WebSocket included, flights summed over the page's parallel connections.
Load average 61 to 449 during the web runs; the lan rows are mostly CPU time. On warm rows the
sequential round trips count chains of requests answered from the cache, not the network.

|                              | First content | Requests | KB (HTTP) | Sequential RT | Link down | Link flights |
| ---------------------------- | ------------- | -------- | --------- | ------------- | --------- | ------------ |
| daemon 3g-slow (run 1), cold | 24134 ms      | 413      | 758       | 3             | 937 KiB   | 219          |
| daemon 3g-slow (run 1), warm | 1828 ms       | 476      | 0         | 25            | 2 KiB     | 4            |
| daemon 3g-slow (run 2), cold | 24531 ms      | 418      | 758       | 3             | 935 KiB   | 222          |
| daemon 3g-slow (run 2), warm | 2416 ms       | 423      | 0         | 28            | 2 KiB     | 5            |
| daemon 3g-fast, cold         | 13716 ms      | 413      | 772       | 3             | 931 KiB   | 220          |
| daemon 3g-fast, warm         | 1168 ms       | 412      | 0         | 25            | 2 KiB     | 4            |
| daemon lan, cold             | 376 ms        | 413      | 1271      | 5             | 1239 KiB  | 335          |
| daemon lan, warm             | 222 ms        | 412      | 0         | 25            | 7 KiB     | 10           |
| preview 3g-slow, cold        | 25780 ms      | 408      | 837       | 3             | –         | –            |
| preview 3g-slow, warm        | 14855 ms      | 410      | 35        | 3             | –         | –            |

- **A cold first visit on 3g-slow takes about 24 s**: 413 to 418 script and style requests and
  about 936 KiB on the link before the first message shows. A warm visit takes 1.8–2.4 s and 2 KiB.

## Limits of the model

- **No congestion control.** The link is a fixed-rate bottleneck with fair turns: no slow start,
  no window cut after a loss, no competing traffic from outside the shaper.
- **Loss is independent per segment**, with no bursts and no backed-off second timeout.
- **Bytes are TCP payload**: TLS records included, IP and TCP headers not.
- **The relay is the local Node relay (`@ace/relay`), not the Cloudflare Worker**, which cannot
  run here. It is reached over plain `ws://`, so the relay rows leave out the TLS handshake the
  hosted relay adds (one round trip on TLS 1.3 and a few KiB of certificate). Only the
  client-to-relay leg is shaped; the daemon-to-relay leg is loopback.
- **The large thread's snapshot is its tail window** (about 58 KiB), as the client asks for;
  older history is paged on demand and is not measured here.
- **One machine runs everything.** The daemon, client, relay, browser and shaper share the Mac's
  CPU at load averages of 137 to 449; the lan rows are mostly CPU time and move with load.
- **Approval delay crosses two processes**: the daemon's emit time to the client's receipt, both
  read as epoch milliseconds on the same machine.
- **The web `preview` target** uses Chromium's emulation, which applies latency per request and
  has no loss; it is not comparable with the `daemon` rows.
- **Isolation.** Every daemon runs in its own temporary home with an empty PATH: nothing reads or
  writes `~/.ace`, no live daemon or provider CLI is involved, and the benches call no outside
  service: every socket is on loopback (the web build and git checks are local). Thread content comes from recorded sessions folded through each provider's real
  translator; streaming turns and the remote child use scripted providers.
