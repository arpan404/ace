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

## After the networking batch (main 453ff5d517)

Measured on 2026-11-14 at `453ff5d517` plus this branch's bench changes (below), after #2027
(wire trims), #2028 (connect round trips), #2030 (thread open), #2033 (iOS transport) and #2045
(machine links). Every bench ran three times on each profile, interleaved, with the same seeds
as the baseline; tables give the median and the spread of the three. The baseline (the
sections above, recorded at the #2038 head) was one run per profile, two for the web 3g-slow
visit. The Mac was heavily loaded throughout: 1-minute load averages of 408 to 967 at the
start and end of each bench. Shaped figures are set by the link and held steady across rounds
(most spreads under 3%); the lan rows are CPU time at that load and move with it.
Raw results, one file per round: [slow-link-after/](slow-link-after/).

### What the benches had to change to see the batch

The real client's new behaviour lives in the shared `packages/client`, which the slow-link bench
already used, so early subscribes (#2028), the overlapped ticket exchange and handed tickets, the
hello's `trims` and `framing` (#2027) and the daemon's link-aware batching reach it unchanged.
Three changes were needed (commit `65214a9981`):

- **`slow-link.ts` client options.** The web app opens threads from a screenful
  (`openTail: screenTail`, #2030) and runs liveness on a monotonic clock; the bench client did
  neither, so it would have kept receiving full snapshots. It now passes both, as
  `apps/web/src/boot/client.ts` does.
- **What "complete" means.** A thread opened from a tail paints first and then is replaced by
  the full snapshot; the bench now counts a thread complete only once that has happened
  (`filling` cleared). First content still times the first paint.
- **A second connect.** A handed ticket lives in the client's memory, so it serves a reconnect
  of the same client, not an app relaunch. The bench now measures the same client dropping and
  reconnecting at once ("reconnect, same client"), and every span records how many TCP
  connections it opened: 2 on the direct path when a ticket is exchanged, 1 when one is handed.
- **`machine-link.ts`** already went through the daemon's own machine transport, which now
  passes the kept-open connection pool to each request, so #2045 is seen as is. It now also
  reports new connections per minute.

What the benches cannot see:

- **The cached account grant (#2028)** applies to the account-signed relay path. The relay
  bench pairs with a device token, so it neither fetches nor caches a grant; its welcome is
  unchanged for that reason, not because the cache does nothing.
- **#2033** changes the iOS transport, which no bench here runs.
- **`preview` web runs** feed the app from the perf worker's endless agent, not a daemon: they
  cannot see any daemon or wire change, and serve only as a check that the app shell itself
  did not move.
- **The web app's cold visit** is mostly the app bundle (760 KB) served by the bench daemon.
  The batch did not touch the bundle, and people's browsers load the shell from app.acehq.dev,
  so this row does not measure the batch.

### Round trips: count versus time

The counted round trips (handshakes plus client flights) are summed over every connection a step
opens. Since #2028 the ticket exchange runs on its own connection in parallel with the
WebSocket dial, so the direct welcome still counts 8 while its time fell by about three round
trips. On shaped links read the time; as a guide, 3g-slow costs 400 ms per round trip and
3g-fast 300 ms.

### Daemon to client, before → after

| direct 3g-slow                                | before                    | after (median of 3, ms spread)         | Δ ms  | Δ KiB down | Δ RT |
| --------------------------------------------- | ------------------------- | -------------------------------------- | ----- | ---------- | ---- |
| Connect → welcome                             | 3716 ms · 8 RT · 6.0 KiB  | 2460 ms (2456–2481) · 8 RT · 6.1 KiB   | -1256 | +0.1       | +0   |
| Connect → first sidebar rows                  | 4228 ms · 9 RT · 9.8 KiB  | 2580 ms (2555–2586) · 8 RT · 10.0 KiB  | -1648 | +0.2       | -1   |
| Small thread, first content                   | 476 ms · 1 RT · 2.4 KiB   | 458 ms (456–468) · 1 RT · 1.7 KiB      | -18   | -0.7       | +0   |
| Typical thread, first content                 | 1107 ms · 1 RT · 33.5 KiB | 531 ms (531–543) · 1 RT · 5.7 KiB      | -576  | -27.8      | +0   |
| Large thread, first content                   | 1624 ms · 1 RT · 58.5 KiB | 693 ms (682–698) · 1 RT · 13.3 KiB     | -931  | -45.2      | +0   |
| Typical thread, complete                      | 1107 ms · 1 RT · 33.5 KiB | 1365 ms (1354–1387) · 2 RT · 25.7 KiB  | +258  | -7.8       | +1   |
| Large thread, complete                        | 1624 ms · 1 RT · 58.5 KiB | 1899 ms (1851–2422) · 2 RT · 58.6 KiB  | +275  | +0.1       | +1   |
| Kept thread, painted from disk                | 6 ms · 0 RT · 0.0 KiB     | 5 ms (4–9) · 0 RT · 0.0 KiB            | -1    | +0.0       | +0   |
| Kept thread, connect → confirmed (new client) | 3552 ms · 11 RT · 6.2 KiB | 1857 ms (1841–1897) · 10 RT · 11.5 KiB | -1695 | +5.3       | -1   |
| Reconnect, same client → welcome              | not measured              | 1777 ms (1769–1827) · 6 RT · 3.3 KiB   | –     | –          | –    |
| Reconnect, same client → confirmed            | not measured              | 1778 ms (1770–1827) · 6 RT · 3.3 KiB   | –     | –          | –    |
| Catch-up after a 2,000-delta turn             | 4465 ms · 9 RT · 16.9 KiB | 2234 ms (1876–2533) · 4 RT · 9.5 KiB   | -2231 | -7.4       | -5   |
| Approval delay, idle link                     | 392 ms                    | 420 ms (420–422)                       | +28   | –          | –    |
| Approval delay, behind the large snapshot     | 1792 ms                   | 396 ms (391–419)                       | -1396 | –          | –    |

| relay 3g-slow                                 | before                    | after (median of 3, ms spread)        | Δ ms  | Δ KiB down | Δ RT |
| --------------------------------------------- | ------------------------- | ------------------------------------- | ----- | ---------- | ---- |
| Connect → welcome                             | 2277 ms · 4 RT · 0.4 KiB  | 2295 ms (2290–2310) · 4 RT · 0.4 KiB  | +18   | +0.0       | +0   |
| Connect → first sidebar rows                  | 2773 ms · 5 RT · 4.2 KiB  | 2390 ms (2380–2397) · 4 RT · 4.3 KiB  | -383  | +0.1       | -1   |
| Small thread, first content                   | 466 ms · 1 RT · 2.5 KiB   | 452 ms (452–454) · 1 RT · 1.7 KiB     | -14   | -0.8       | +0   |
| Typical thread, first content                 | 1103 ms · 1 RT · 33.5 KiB | 534 ms (532–534) · 1 RT · 5.7 KiB     | -569  | -27.8      | +0   |
| Large thread, first content                   | 1616 ms · 1 RT · 60.6 KiB | 687 ms (684–712) · 1 RT · 15.0 KiB    | -929  | -45.5      | +0   |
| Typical thread, complete                      | 1103 ms · 1 RT · 33.5 KiB | 1374 ms (1360–1439) · 2 RT · 25.6 KiB | +271  | -7.9       | +1   |
| Large thread, complete                        | 1616 ms · 1 RT · 60.6 KiB | 1862 ms (1830–2426) · 2 RT · 61.4 KiB | +246  | +0.8       | +1   |
| Kept thread, painted from disk                | 3 ms · 0 RT · 0.0 KiB     | 3 ms (3–3) · 0 RT · 0.0 KiB           | +0    | +0.0       | +0   |
| Kept thread, connect → confirmed (new client) | 2066 ms · 5 RT · 0.5 KiB  | 1681 ms (1679–1688) · 5 RT · 7.0 KiB  | -385  | +6.5       | +0   |
| Reconnect, same client → welcome              | not measured              | 1694 ms (1657–1711) · 5 RT · 0.4 KiB  | –     | –          | –    |
| Reconnect, same client → confirmed            | not measured              | 1694 ms (1662–1717) · 5 RT · 0.5 KiB  | –     | –          | –    |
| Catch-up after a 2,000-delta turn             | 2736 ms · 5 RT · 7.8 KiB  | 2335 ms (2278–2349) · 5 RT · 7.0 KiB  | -401  | -0.8       | +0   |
| Approval delay, idle link                     | 371 ms                    | 361 ms (361–376)                      | -10   | –          | –    |
| Approval delay, behind the large snapshot     | 1896 ms                   | 376 ms (375–383)                      | -1520 | –          | –    |

| direct 3g-fast                                | before                     | after (median of 3, ms spread)        | Δ ms  | Δ KiB down | Δ RT |
| --------------------------------------------- | -------------------------- | ------------------------------------- | ----- | ---------- | ---- |
| Connect → welcome                             | 2674 ms · 8 RT · 6.0 KiB   | 1757 ms (1743–1757) · 8 RT · 6.1 KiB  | -917  | +0.1       | +0   |
| Connect → first sidebar rows                  | 3015 ms · 9 RT · 9.8 KiB   | 1787 ms (1783–1807) · 8 RT · 10.0 KiB | -1228 | +0.2       | -1   |
| Small thread, first content                   | 330 ms · 1 RT · 2.5 KiB    | 324 ms (318–327) · 1 RT · 1.8 KiB     | -6    | -0.7       | +0   |
| Typical thread, first content                 | 487 ms · 1 RT · 33.6 KiB   | 338 ms (337–362) · 1 RT · 5.7 KiB     | -149  | -27.9      | +0   |
| Large thread, first content                   | 628 ms · 1 RT · 58.5 KiB   | 381 ms (377–407) · 1 RT · 13.2 KiB    | -247  | -45.3      | +0   |
| Typical thread, complete                      | 487 ms · 1 RT · 33.6 KiB   | 769 ms (751–789) · 2 RT · 25.6 KiB    | +282  | -8.0       | +1   |
| Large thread, complete                        | 628 ms · 1 RT · 58.5 KiB   | 882 ms (878–909) · 2 RT · 58.9 KiB    | +254  | +0.4       | +1   |
| Kept thread, painted from disk                | 4 ms · 0 RT · 0.0 KiB      | 4 ms (3–4) · 0 RT · 0.0 KiB           | +0    | +0.0       | +0   |
| Kept thread, connect → confirmed (new client) | 2510 ms · 11 RT · 10.0 KiB | 1283 ms (1282–1745) · 10 RT · 6.3 KiB | -1227 | -3.7       | -1   |
| Reconnect, same client → welcome              | not measured               | 1256 ms (1255–1257) · 6 RT · 3.3 KiB  | –     | –          | –    |
| Reconnect, same client → confirmed            | not measured               | 1257 ms (1255–1259) · 6 RT · 3.3 KiB  | –     | –          | –    |
| Catch-up after a 2,000-delta turn             | 2534 ms · 9 RT · 13.3 KiB  | 1371 ms (1298–1494) · 4 RT · 25.1 KiB | -1163 | +11.8      | -5   |
| Approval delay, idle link                     | 200 ms                     | 201 ms (200–203)                      | +1    | –          | –    |
| Approval delay, behind the large snapshot     | 738 ms                     | 203 ms (199–203)                      | -535  | –          | –    |

| relay 3g-fast                                 | before                    | after (median of 3, ms spread)       | Δ ms | Δ KiB down | Δ RT |
| --------------------------------------------- | ------------------------- | ------------------------------------ | ---- | ---------- | ---- |
| Connect → welcome                             | 1722 ms · 4 RT · 0.4 KiB  | 1711 ms (1704–1722) · 4 RT · 0.4 KiB | -11  | +0.0       | +0   |
| Connect → first sidebar rows                  | 2055 ms · 5 RT · 4.2 KiB  | 1752 ms (1735–1757) · 4 RT · 4.2 KiB | -303 | +0.1       | -1   |
| Small thread, first content                   | 324 ms · 1 RT · 2.5 KiB   | 319 ms (318–331) · 1 RT · 1.8 KiB    | -5   | -0.7       | +0   |
| Typical thread, first content                 | 488 ms · 1 RT · 33.7 KiB  | 340 ms (338–343) · 1 RT · 5.7 KiB    | -148 | -28.0      | +0   |
| Large thread, first content                   | 619 ms · 1 RT · 60.1 KiB  | 392 ms (376–394) · 1 RT · 15.4 KiB   | -227 | -44.7      | +0   |
| Typical thread, complete                      | 488 ms · 1 RT · 33.7 KiB  | 758 ms (752–767) · 2 RT · 25.5 KiB   | +270 | -8.2       | +1   |
| Large thread, complete                        | 619 ms · 1 RT · 60.1 KiB  | 900 ms (877–933) · 2 RT · 60.3 KiB   | +281 | +0.3       | +1   |
| Kept thread, painted from disk                | 4 ms · 0 RT · 0.0 KiB     | 4 ms (3–4) · 0 RT · 0.0 KiB          | +0   | +0.0       | +0   |
| Kept thread, connect → confirmed (new client) | 1551 ms · 5 RT · 0.5 KiB  | 1682 ms (1232–1702) · 4 RT · 0.5 KiB | +131 | +0.0       | -1   |
| Reconnect, same client → welcome              | not measured              | 1226 ms (1225–1251) · 5 RT · 0.5 KiB | –    | –          | –    |
| Reconnect, same client → confirmed            | not measured              | 1226 ms (1226–1251) · 5 RT · 0.5 KiB | –    | –          | –    |
| Catch-up after a 2,000-delta turn             | 1598 ms · 5 RT · 13.0 KiB | 1297 ms (1271–1356) · 4 RT · 7.0 KiB | -301 | -6.0       | -1   |
| Approval delay, idle link                     | 189 ms                    | 190 ms (188–193)                     | +1   | –          | –    |
| Approval delay, behind the large snapshot     | 753 ms                    | 192 ms (187–198)                     | -561 | –          | –    |

Lan, mostly CPU time at load averages in the hundreds:

| direct lan                                    | before                  | after (median of 3, ms spread)   | Δ ms | Δ KiB down | Δ RT |
| --------------------------------------------- | ----------------------- | -------------------------------- | ---- | ---------- | ---- |
| Connect → welcome                             | 32 ms · 8 RT · 6.0 KiB  | 99 ms (23–262) · 8 RT · 6.1 KiB  | +67  | +0.1       | +0   |
| Connect → first sidebar rows                  | 47 ms · 9 RT · 9.8 KiB  | 112 ms (34–462) · 8 RT · 9.9 KiB | +65  | +0.1       | -1   |
| Small thread, first content                   | 11 ms · 1 RT · 2.5 KiB  | 10 ms (8–14) · 1 RT · 2.6 KiB    | -1   | +0.1       | +0   |
| Typical thread, first content                 | 13 ms · 1 RT · 34.4 KiB | 8 ms (5–8) · 1 RT · 7.3 KiB      | -5   | -27.1      | +0   |
| Large thread, first content                   | 20 ms · 1 RT · 59.9 KiB | 19 ms (9–24) · 1 RT · 13.8 KiB   | -1   | -46.1      | +0   |
| Typical thread, complete                      | 13 ms · 1 RT · 34.4 KiB | 19 ms (13–20) · 2 RT · 28.9 KiB  | +6   | -5.6       | +1   |
| Large thread, complete                        | 20 ms · 1 RT · 59.9 KiB | 49 ms (31–211) · 2 RT · 54.1 KiB | +29  | -5.8       | +1   |
| Kept thread, painted from disk                | 4 ms · 0 RT · 0.0 KiB   | 4 ms (3–4) · 0 RT · 0.0 KiB      | +0   | +0.0       | +0   |
| Kept thread, connect → confirmed (new client) | 49 ms · 11 RT · 6.2 KiB | 28 ms (27–46) · 10 RT · 6.3 KiB  | -21  | +0.1       | -1   |
| Reconnect, same client → welcome              | not measured            | 13 ms (12–23) · 6 RT · 3.3 KiB   | –    | –          | –    |
| Reconnect, same client → confirmed            | not measured            | 13 ms (12–23) · 6 RT · 3.3 KiB   | –    | –          | –    |
| Catch-up after a 2,000-delta turn             | 30 ms · 9 RT · 13.3 KiB | 20 ms (17–26) · 4 RT · 9.1 KiB   | -10  | -4.1       | -5   |
| Approval delay, idle link                     | 20 ms                   | 16 ms (10–102)                   | -4   | –          | –    |
| Approval delay, behind the large snapshot     | 12 ms                   | 19 ms (15–189)                   | +7   | –          | –    |

| relay lan                                     | before                  | after (median of 3, ms spread)    | Δ ms | Δ KiB down | Δ RT |
| --------------------------------------------- | ----------------------- | --------------------------------- | ---- | ---------- | ---- |
| Connect → welcome                             | 70 ms · 4 RT · 0.4 KiB  | 54 ms (23–103) · 5 RT · 0.4 KiB   | -16  | +0.0       | +1   |
| Connect → first sidebar rows                  | 105 ms · 5 RT · 4.2 KiB | 75 ms (34–133) · 5 RT · 4.2 KiB   | -30  | +0.1       | +0   |
| Small thread, first content                   | 30 ms · 1 RT · 3.3 KiB  | 11 ms (8–36) · 1 RT · 1.8 KiB     | -19  | -1.5       | +0   |
| Typical thread, first content                 | 16 ms · 1 RT · 33.5 KiB | 9 ms (6–9) · 1 RT · 6.5 KiB       | -7   | -27.0      | +0   |
| Large thread, first content                   | 25 ms · 1 RT · 59.8 KiB | 47 ms (9–100) · 1 RT · 13.8 KiB   | +22  | -46.1      | +0   |
| Typical thread, complete                      | 16 ms · 1 RT · 33.5 KiB | 26 ms (16–27) · 2 RT · 27.1 KiB   | +10  | -6.4       | +1   |
| Large thread, complete                        | 25 ms · 1 RT · 59.8 KiB | 104 ms (30–126) · 2 RT · 54.3 KiB | +79  | -5.5       | +1   |
| Kept thread, painted from disk                | 4 ms · 0 RT · 0.0 KiB   | 3 ms (3–4) · 0 RT · 0.0 KiB       | -1   | +0.0       | +0   |
| Kept thread, connect → confirmed (new client) | 43 ms · 5 RT · 0.5 KiB  | 40 ms (32–50) · 6 RT · 0.5 KiB    | -3   | +0.0       | +1   |
| Reconnect, same client → welcome              | not measured            | 23 ms (11–34) · 4 RT · 0.5 KiB    | –    | –          | –    |
| Reconnect, same client → confirmed            | not measured            | 24 ms (11–34) · 4 RT · 0.5 KiB    | –    | –          | –    |
| Catch-up after a 2,000-delta turn             | 29 ms · 5 RT · 8.4 KiB  | 42 ms (18–47) · 5 RT · 7.9 KiB    | +13  | -0.5       | +0   |
| Approval delay, idle link                     | 19 ms                   | 16 ms (15–80)                     | -3   | –          | –    |
| Approval delay, behind the large snapshot     | 16 ms                   | 20 ms (14–34)                     | +4   | –          | –    |

What moved, and what did not:

- **Connect, direct path: −1.26 s on 3g-slow (3.72 → 2.46 s), −0.92 s on 3g-fast.** About three
  round trips of time saved; the count stays 8 because the overlapped ticket connection's
  flights are summed in. A same-client reconnect with a handed ticket opens one connection and
  takes 1.78 s on 3g-slow, about 4.4 round trips (TCP, TLS, upgrade, hello). The first connect is
  still about 0.7 s (two round trips) slower than that; it opens the ticket connection alongside
  the dial, and the bench did not trace which of the two finishes last.
- **Connect, relay path: unchanged (2.28 → 2.30 s).** A relay attempt fetches its own
  credential to dial, and relayed sockets get no handed ticket (ADR 0150); the grant cache is
  not exercised (above). Its sidebar arrives 0.38 s sooner, from the early subscribe.
- **Sidebar: one round trip sooner on both paths** (the subscribe goes with the hello); on the
  direct path it lands 0.1 s after welcome instead of 0.5 s.
- **First content of an unseen thread: about half.** Typical 1.11 → 0.53 s and 33.5 → 5.7 KiB;
  large 1.62 → 0.69 s and 58.5 → 13.3 KiB on 3g-slow. The small thread was already one screenful.
- **Completion got slower, by design: +0.25 to +0.28 s.** The full snapshot that replaces the
  tail is asked for after it, one more round trip (2 RT instead of 1); the typical thread's
  completion carries 7.8 KiB less, the large one's the same.
- **Approval behind the large snapshot: 1.79 → 0.40 s on 3g-slow**, now the same as on an idle
  link: what it waited behind was the snapshot, which is now a 13 KiB tail.
- **Kept thread after a relaunch: 3.55 → 1.86 s direct, 2.07 → 1.68 s relay on 3g-slow.** It
  confirms before a cold client's first welcome (2.46 s); the bench does not show why a
  relaunched client is faster than a first one. Bytes went up on 3g-slow (6.2 → 11.5 KiB direct,
  0.5 → 7.0 KiB relay) but not on 3g-fast (10.0 → 6.3 KiB, 0.5 → 0.5 KiB): the spread is in
  whether the resumed copy gets a replay or a snapshot, not traced further.
- **Catch-up after the 2,000-delta turn: −0.3 to −2.2 s, bytes mixed.** Time fell with the
  connect. On the wire it is one replay of short deltas (2,000 deltas in 7 to 25 KiB, against
  about 274 KB once the client has expanded them). Bytes moved from 16.9 to 9.5 KiB on 3g-slow
  direct but from 13.3 to 25.1 KiB on 3g-fast direct; the baseline's catch-up already ranged 13 to
  23 KiB across four runs, so these single before-figures cannot show a change either way.
- **Approval on an idle link: unchanged** (392 → 420 ms on 3g-slow, a single baseline sample;
  about one round trip).

### Daemon to daemon, before → after

|                                                | 3g-slow before → after (median, spread) | 3g-fast before → after (median, spread) | lan before → after (median, spread) |
| ---------------------------------------------- | --------------------------------------- | --------------------------------------- | ----------------------------------- |
| One status call, ms (median)                   | 1361 → 444.0 (439.0–445.0)              | 958 → 319.0 (316.0–321.0)               | 10 → 9.0 (6.0–10.0)                 |
| Round trips per call                           | 3 → 1.1 (1.1–1.1)                       | 3.1 → 1.0 (1.0–1.0)                     | 3 → 1.0 (1.0–1.0)                   |
| KiB per call, both ways                        | 5.1 → 1.1 (1.1–1.1)                     | 5.2 → 1.1 (1.1–1.1)                     | 5.1 → 1.1 (1.1–1.1)                 |
| Status calls/min, child running                | 25 → 40.0 (40.0–40.0)                   | 29 → 44.0 (44.0–44.0)                   | 58 → 58.0 (58.0–59.0)               |
| Status calls/min, settled                      | 6 → 6.0 (6.0–6.0)                       | 6 → 6.0 (6.0–6.0)                       | 6 → 6.0 (6.0–6.0)                   |
| New connections/min, child running             | 25 → 1.0 (1.0–1.0)                      | 30 → 1.0 (1.0–1.0)                      | 58 → 1.0 (1.0–1.0)                  |
| New connections/min, settled                   | 6 → 0.0 (0.0–0.0)                       | 6 → 0.0 (0.0–0.0)                       | 6 → 0.0 (0.0–0.0)                   |
| Link KiB/min, child running (down+up)          | 127 → 43.4 (43.4–43.4)                  | 152 → 47.4 (47.4–47.4)                  | 295 → 61.4 (61.4–62.4)              |
| delegate_task, ms                              | 1442 → 536.0 (504.0–750.0)              | 1060 → 401.0 (381.0–433.0)              | 127 → 81.0 (59.0–146.0)             |
| Child finished → first answer reporting it, ms | 2266 → 729.0 (725.0–928.0)              | 2030 → 992.0 (773.0–1154.0)             | 149 → 403.0 (374.0–959.0)           |

- **Each status call is now one round trip and 1.1 KiB** (was 3 round trips, about 5 KiB, a
  new TLS connection each), so it takes a third of the time: 1.36 → 0.44 s on 3g-slow.
- **New connections per minute went to zero once settled** and to one while the child runs
  (which connection opens in that window was not traced), from one per call.
- **Calls per minute went up, 25 → 40 on 3g-slow.** Not more work per poll: the source polls
  about a second after each answer, and answers now come back three times sooner. Bytes per
  minute fell by two thirds (127 → 43 KiB).
- **Child finished → first answer** is one sample per profile and depends on where in the poll
  the finish lands: 0.73 s median on 3g-slow (was 2.27 s, also one sample); on lan it rose
  149 → 403 ms with a spread of 374–959 ms, which is the poll phase, not the link.

### Web app, before → after

|                                                                                                                                                                                                                       | before                                | after (median, ms spread)                           | Δ ms | Δ link KiB |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- | ---- | ---------- |
| daemon 3g-slow, cold                                                                                                                                                                                                  | 24332 ms · 758 KB HTTP · link 936 KiB | 24482 ms (23926–24485) · 760 KB HTTP · link 934 KiB | +149 | -2         |
| daemon 3g-slow, warm                                                                                                                                                                                                  | 2122 ms · 0 KB HTTP · link 2 KiB      | 1660 ms (1590–1754) · 0 KB HTTP · link 2 KiB        | -462 | -0         |
| daemon 3g-fast, cold                                                                                                                                                                                                  | 13716 ms · 772 KB HTTP · link 931 KiB | 13465 ms (13229–13808) · 760 KB HTTP · link 928 KiB | -251 | -4         |
| daemon 3g-fast, warm                                                                                                                                                                                                  | 1168 ms · 0 KB HTTP · link 2 KiB      | 1240 ms (1169–1269) · 0 KB HTTP · link 2 KiB        | +71  | +0         |
| daemon lan, cold                                                                                                                                                                                                      | 376 ms · 1271 KB HTTP · link 1239 KiB | 316 ms (251–401) · 896 KB HTTP · link 1031 KiB      | -60  | -208       |
| daemon lan, warm                                                                                                                                                                                                      | 222 ms · 0 KB HTTP · link 7 KiB       | 312 ms (275–336) · 1 KB HTTP · link 8 KiB           | +89  | +1         |
| preview 3g-slow, cold                                                                                                                                                                                                 | 25780 ms · 837 KB HTTP                | 25986 ms (25973–25999) · 840 KB HTTP                | +205 | –          |
| preview 3g-slow, warm                                                                                                                                                                                                 | 14855 ms · 35 KB HTTP                 | 14902 ms (14900–14904) · 35 KB HTTP                 | +47  | –          |
| LOADS [(512.37646484375, 885.615234375), (896.4443359375, 829.31884765625), (433.642578125, 576.36181640625)] [(885.615234375, 407.77685546875), (829.31884765625, 966.49609375), (576.36181640625, 454.49755859375)] |

- **Warm visit on 3g-slow: 2.12 → 1.66 s** (the baseline is the median of its two runs). The
  page is reloaded, so its new client gets no handed ticket; the gain is the early subscribe.
- **Cold visits: unchanged**: the bundle, not the batch (above). The lan rows are CPU-bound.

### Distance to the 1 s target (returning client on 3G)

The owner's target is under 1 s to the first usable screen and to an open thread on 3G for a
returning client. On `3g-slow` (400 kbit/s, 400 ms round trip, 2% loss), medians:

| Returning client                                         | direct                           | relay          | target gap (direct / relay) |
| -------------------------------------------------------- | -------------------------------- | -------------- | --------------------------- |
| Kept screen painted from disk (unconfirmed copy)         | 5 ms                             | 3 ms           | met                         |
| App relaunch → kept thread confirmed live                | 1.86 s                           | 1.68 s         | +0.86 s / +0.68 s           |
| Same client reconnecting → welcome and thread confirmed  | 1.78 s                           | 1.69 s         | +0.78 s / +0.69 s           |
| Connected, open an unseen typical thread → first content | 0.53 s                           | 0.53 s         | met (−0.47 s)               |
| Connected, open the large thread → first content         | 0.69 s                           | 0.69 s         | met (−0.31 s)               |
| Connected, open a thread → complete                      | 1.37 s (typical), 1.90 s (large) | 1.37 s, 1.86 s | +0.37 s / +0.90 s           |
| Web app, warm reload → thread on screen                  | 1.66 s                           | –              | +0.66 s                     |
| First connect (new device) → welcome                     | 2.46 s                           | 2.30 s         | +1.46 s / +1.30 s           |

On `3g-fast` the same rows are 1.28 s (relaunch confirmed, direct), 1.26 s (reconnect), 0.34 s
and 0.38 s (thread first content) and 1.24 s (web warm).

The kept copy is on screen at once, so whether a returning client meets the target depends on
whether an unconfirmed copy counts as usable. Every path to confirmed live state still costs
four or more round trips (TCP, TLS, upgrade, hello), about 1.7 s at 400 ms each, before any
data. Reaching 1 s on this link needs that cut to two round trips or fewer: for example a
resumed TLS session with 0-RTT data, or a connection kept warm across app suspends.

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
