# Slow-link baseline (3G)

The numbers below are the baseline for changes to the connection handshake, the wire payloads,
the relay and daemon-to-daemon calls. They were measured on 2026-11-14 on main at `7d29fce008`
plus this harness, on the shared 16-core Mac. How to run a case is in [README.md](README.md#slow-links-3g).
Raw results: [slow-link-results.json](slow-link-results.json),
[machine-link-results.json](machine-link-results.json) and
[web-slow-link-results.json](web-slow-link-results.json).

Host load average (1, 5, 15 min) at the start of each run: slow-link 18.9, 81.0, 199.0;
machine-link 54.8, 50.3, 95.6; web (daemon, 3g-slow) 17.0, 26.1, 67.2. A trial run of slow-link
20 minutes earlier, while the load rose from 181 to 567, matched the shaped welcome, sidebar,
thread and resume rows within 3%; the lan rows are mostly CPU time and move with load. Compare a
change against a baseline taken on the same machine at a similar load, and repeat a case before
reading a small difference.

Profiles: `3g-slow` is 400 kbit/s down, 200 kbit/s up, 400 ms round trip, 2% loss; `3g-fast` is
1.6 Mbit/s down, 750 kbit/s up, 300 ms, 1%; `lan` is unshaped. RT counts round trips: one TCP
handshake per new connection plus each flight the client sent after hearing back. KiB is bytes
the daemon (or the relay) sent to the client, TLS records included.

## Daemon to client (`slow-link.ts`)

The client is the real `packages/client`, paired as a phone. `direct` is the daemon's pinned TLS
listener; `relay` is a local `@ace/relay` with only the client's leg shaped.

|                                                   | direct 3g-slow            | relay 3g-slow             | direct 3g-fast            | relay 3g-fast            | direct lan              | relay lan               |
| ------------------------------------------------- | ------------------------- | ------------------------- | ------------------------- | ------------------------ | ----------------------- | ----------------------- |
| Connect → welcome                                 | 3725 ms · 7 RT · 6.0 KiB  | 2294 ms · 4 RT · 0.4 KiB  | 2676 ms · 7 RT · 6.0 KiB  | 1712 ms · 4 RT · 0.4 KiB | 28 ms · 7 RT · 6.0 KiB  | 25 ms · 5 RT · 0.4 KiB  |
| Connect → first sidebar rows                      | 4229 ms · 8 RT · 9.8 KiB  | 2791 ms · 5 RT · 4.2 KiB  | 3011 ms · 8 RT · 9.8 KiB  | 2045 ms · 5 RT · 4.2 KiB | 44 ms · 8 RT · 9.8 KiB  | 42 ms · 6 RT · 4.2 KiB  |
| Small thread (4 items), first content             | 467 ms · 1 RT · 2.4 KiB   | 466 ms · 1 RT · 2.5 KiB   | 321 ms · 1 RT · 2.4 KiB   | 322 ms · 1 RT · 2.5 KiB  | 6 ms · 1 RT · 2.5 KiB   | 7 ms · 1 RT · 2.5 KiB   |
| Typical thread (123 items), first content         | 1106 ms · 1 RT · 33.6 KiB | 1107 ms · 1 RT · 33.5 KiB | 483 ms · 1 RT · 33.7 KiB  | 484 ms · 2 RT · 33.5 KiB | 9 ms · 1 RT · 33.5 KiB  | 17 ms · 1 RT · 33.5 KiB |
| Large thread (1,500 items), first content         | 1620 ms · 1 RT · 58.4 KiB | 1612 ms · 1 RT · 60.5 KiB | 616 ms · 1 RT · 58.5 KiB  | 616 ms · 1 RT · 60.7 KiB | 21 ms · 1 RT · 58.2 KiB | 15 ms · 1 RT · 58.2 KiB |
| Kept thread, painted from disk                    | 4 ms · 0 RT · 0 KiB       | 3 ms · 0 RT · 0 KiB       | 3 ms · 0 RT · 0 KiB       | 4 ms · 0 RT · 0 KiB      | 3 ms · 0 RT · 0 KiB     | 3 ms · 0 RT · 0 KiB     |
| Kept thread, connect → confirmed                  | 3518 ms · 9 RT · 6.2 KiB  | 2689 ms · 6 RT · 0.5 KiB  | 2512 ms · 9 RT · 6.2 KiB  | 1535 ms · 5 RT · 0.5 KiB | 51 ms · 9 RT · 6.2 KiB  | 54 ms · 6 RT · 0.5 KiB  |
| Resume after a 2,000-delta turn (117 KiB of text) | 4263 ms · 8 RT · 13.1 KiB | 2829 ms · 6 RT · 8.2 KiB  | 2547 ms · 8 RT · 15.0 KiB | 1585 ms · 5 RT · 9.8 KiB | 23 ms · 8 RT · 13.0 KiB | 28 ms · 5 RT · 7.6 KiB  |
| Approval delay, idle link                         | 419 ms                    | 372 ms                    | 202 ms                    | 193 ms                   | 9 ms                    | 13 ms                   |
| Approval delay, behind the large snapshot         | 1705 ms                   | 1805 ms                   | 724 ms                    | 734 ms                   | 8 ms                    | 8 ms                    |

Thread first content and completion were the same moment in every run: each thread arrives as
one snapshot. Thread rows are measured after the sidebar, on a connection already open.

What the rows show:

- **Welcome costs 7 round trips on the direct path** (3.7 s on 3g-slow): a socket ticket is
  fetched over its own HTTPS connection (TCP, TLS, request) before the WebSocket's own TCP, TLS,
  upgrade and hello. Most of the 6 KiB is the two TLS handshakes (the relay row, without TLS,
  is 0.4 KiB). The relay path takes 4 round trips, but see the limits: the local relay has no TLS.
- **The sidebar waits one more round trip after welcome**: it is subscribed only once the
  connection is ready.
- **A kept thread paints from disk in about 3 ms**, then needs the whole connection again
  before the daemon confirms it (3.5 s direct on 3g-slow); the confirmation itself is small.
- **Catching up after a long streamed turn is compact** (8–15 KiB for 117 KiB of streamed
  text, since the client keeps at most 64 KiB of one message); its time is the reconnect.
- **An approval waits behind a snapshot in flight**: 0.4 s on an idle 3g-slow link, 1.7–1.8 s
  while the 58 KiB large-thread snapshot is crossing. This row depends on how much of the
  snapshot is still queued when the approval is sent (the bench sends it once 4 KiB of the
  snapshot has crossed); across runs it moved between about 0.3 and 0.75 s on 3g-fast.

## Daemon to daemon (`machine-link.ts`)

The source machine's agent delegates one task to the target through the shaper; the remote child
runs under a scripted provider; the source polls with the default interval. 60-second windows.

|                                        | 3g-slow                                    | 3g-fast                                   | lan                                      |
| -------------------------------------- | ------------------------------------------ | ----------------------------------------- | ---------------------------------------- |
| delegate_task to the remote machine    | 1405 ms · 3 RT                             | 1042 ms · 3 RT                            | 99 ms · 3 RT                             |
| One status call (median)               | 1357 ms · 3 RT · 3.1 KiB down · 2.1 KiB up | 948 ms · 3 RT · 3.0 KiB down · 2.0 KiB up | 10 ms · 3 RT · 3.0 KiB down · 2.0 KiB up |
| Status calls per minute, child running | 24                                         | 30                                        | 58                                       |
| Status calls per minute, child settled | 6                                          | 6                                         | 6                                        |
| Link bytes per minute, child running   | 75 KiB down · 50 KiB up                    | 91 KiB down · 61 KiB up                   | 177 KiB down · 118 KiB up                |
| Child finished → first status answer   | 5001 ms                                    | 1123 ms                                   | 188 ms                                   |

- **Every status call opens a new TLS connection** (TCP, TLS, request: 3 round trips) and moves
  about 5 KiB in the two directions together.
- **While the child runs, the source polls about once a second after each answer**, so the rate
  is set by the call's own time: 58 a minute on lan, 24 on 3g-slow. Once it settles, 6 a minute.

## Web app (`tools/web-perf/src/slow-link.ts`)

`daemon` is the production build served by the bench daemon's TLS listener, paired as a phone,
through the shaper, opening the typical thread. `preview` is the perf build under `vite preview`
with Chromium's emulation (no loss) and the endless agent's thread. Requests, KB and sequential
round trips are counted by Chromium before first content; `link` is everything on the shaped
link, WebSocket included, summed over the page's parallel connections.

|                       | First content | Requests | KB (HTTP) | Sequential RT | Link down | Link flights |
| --------------------- | ------------- | -------- | --------- | ------------- | --------- | ------------ |
| daemon 3g-slow, cold  | 20281 ms      | 413      | 758       | 3             | 936 KiB   | 223          |
| daemon 3g-slow, warm  | 1580 ms       | 497      | 0         | 9             | 14 KiB    | 15           |
| daemon 3g-fast, cold  | 12669 ms      | 413      | 758       | 3             | 932 KiB   | 221          |
| daemon 3g-fast, warm  | 1132 ms       | 421      | 0         | 9             | 14 KiB    | 22           |
| daemon lan, cold      | 269 ms        | 413      | 1147      | 5             | 1336 KiB  | 384          |
| daemon lan, warm      | 309 ms        | 428      | 93        | 17            | 171 KiB   | 60           |
| preview 3g-slow, cold | 25764 ms      | 413      | 837       | 3             | –         | –            |
| preview 3g-slow, warm | 15408 ms      | 410      | 60        | 3             | –         | –            |

- **A cold first visit on 3g-slow takes 20 s**: about 413 script and style requests and 930 KiB
  before the first message shows.
- On lan the page fetches more before first content (1.1 MB) because chunks arrive before the
  transcript renders; read the shaped rows.
- A warm visit on 3g-slow shows the thread in 1.6 s and moves 14 KiB.

## Limits of the model

- **No congestion control.** The shaper is a fixed-rate pipe with a bounded queue: no slow start,
  no window collapse after a loss, no competing traffic. Real 3G ramps up over the first round
  trips, so large first transfers are somewhat optimistic here.
- **Loss is a stall, not a drop.** A lost segment (independently, at the profile's rate) arrives
  one retransmission timeout late (600 ms on 3g-slow) and holds everything behind it, as TCP
  presents it; bursts of loss and timeouts that back off are not modelled.
- **Round trips are counted, not inferred.** A flight is a run of bytes in one direction; on lan,
  where both sides answer instantly, flights can split or merge differently, so read RT from
  the shaped profiles.
- **Bytes are TCP payload**: TLS records included, IP and TCP headers not.
- **The relay is the local Node relay (`@ace/relay`), not the Cloudflare Worker**, which cannot
  run here. It is reached over plain `ws://`, so the relay rows leave out the TLS handshake the
  hosted relay adds (one round trip on TLS 1.3 and a few KiB of certificate). Only the
  client-to-relay leg is shaped; the daemon-to-relay leg is loopback.
- **The large thread's snapshot is its tail window** (about 58 KiB), as the client asks for;
  older history is paged on demand and is not measured here.
- **One machine runs everything.** The daemon, client, relay and shaper share the Mac's CPU;
  the lan rows are mostly CPU time and move with load.
- **Approval delay crosses two processes**: it is the daemon's emit time to the client's receipt,
  both read from `performance.timeOrigin + performance.now()` on the same machine.
- **The web `preview` target** uses Chromium's emulation, which applies latency per request and
  has no loss; it is not comparable with the `daemon` rows.
- **No real provider CLI.** Thread content comes from the recorded sessions, folded through each
  provider's real translator; streaming turns and the remote child use scripted providers.
