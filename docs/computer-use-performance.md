# Computer use performance (macOS)

Measurements for #1130: how sharp the live view of a Mac app is, and how long an agent's
`screen_state` / `screen_act` calls take. Raw results are in [perf/computer-use](perf/computer-use).
Apple M4 Max (16 cores), macOS 26, Retina display (2x). Host load average during the runs is
in each JSON file (10–17 for the action runs: other agents were busy on the same Mac).

The [2026-10-23 action-overhead follow-up](perf/computer-use/speed-2026-10-23.md)
records the later conflict-query, semantic-edit and explicit-wait optimizations,
with duration-only request diagnostics and fresh before/after measurements.

## What changed

**Live view (`ace-screen-helper`, shared with Devices):**

- H.264 **High** at a fixed level 5.1 instead of Baseline. Same bitrate, sharper text in motion
  (40.9 dB vs 38.1 dB below), and a refine keyframe never changes the decoder configuration.
- **Refine on idle.** When the picture has not changed for 300 ms, the helper sends it once
  more as a keyframe with capped quantisation, so a still window is near-lossless. The QP cap
  is chosen so the frame reaches a viewer within about 1.5 s at the negotiated bitrate
  (`refineFrameQP`). Any change goes back to motion settings; the next frames are cheap
  P-frames that keep the refined detail wherever nothing moved. A keyframe or screenshot asked
  for while still is refined too. The JPEG path does the same at quality 0.92 (motion 0.75).
- **Rate-control drops no longer force keyframes.** Low-latency rate control drops a frame
  (no sample, no error) when it is over budget. The encoder treated that as an error and
  forced a keyframe, which overspent again and was dropped again: at 1.2–2.5 Mbps a scrolling
  window froze on its fifth frame. Only encoder errors ask for a keyframe now, and a dropped
  refine is retried after another idle interval (up to three times).
- **Native pixel density, no upscaling.** A negotiated capture size is clamped to the
  display's own pixels for windows and whole displays (`streamCaptureSize`); a viewer asking
  for more no longer gets an upscaled, blurrier capture.
- **Window crops without the shadow** (`ignoreShadowsSingleWindow`, macOS 14+), so the window
  fills the frame edge to edge at the right aspect.
- Encoder presentation times follow the capture clock, so rate control sees idle time; the
  encoded sample is copied once into the packet (NAL lengths rewritten to start codes in
  place) instead of three times.

**Agent actions (`--computer` engine):**

- **Settle when the app has answered.** After an action the engine waited for 150 ms without
  accessibility notifications (100 ms between steps). Now, once the app has reacted to the
  action, 60 ms of quiet is enough (40 ms between steps); an app that has not reacted yet
  still gets the full interval (`CUSettleWindow`).
- **One round trip per known element.** A walk remembers each element's role and reads a
  known element's geometry and role-specific attributes together, confirming the role in the
  same read. Action names are reused until the app reports a change on that element, it is
  destroyed or 10 s pass (`CUElementFacts`).
- **`screen_act` schema: 8.8 KB → 4.8 KB.** The model reads one flat step object with each
  field once and a one-line grammar on `type`; calls are still validated against the strict
  per-step union, so a field a step does not take is an error naming it.

## Live view text sharpness

`sh native/screen-helper/bench-stream.sh` renders a 1600×1000 window of dense UI text at 2x,
scrolls it for 30 frames at 60 fps and then holds it still, through the helper's own encoders.
Each packet is decoded with VideoToolbox (what WebCodecs uses on a Mac) and compared with the
source: luma PSNR, and the mean absolute error on text edges (0 = pixel-identical). "Before"
builds the same benchmark against main's encoders (`sh bench-stream.sh <main checkout>/native/screen-helper`).

| What the viewer sees once the window holds still | Before (main)                   | After                               |
| ------------------------------------------------ | ------------------------------- | ----------------------------------- |
| H.264 6 Mbps (local)                             | 38.1 dB, edge error 4.5         | **49.6 dB, edge error 0.9**         |
| H.264 2.5 Mbps                                   | frozen on frame 6 of 30 (10 dB) | **41.3 dB, edge error 2.8**         |
| H.264 1.2 Mbps (relay)                           | frozen on frame 5 of 30 (11 dB) | **41.3 dB** (refine's 3rd try)      |
| H.264 6 Mbps, last moving frame                  | 38.1 dB (Baseline)              | 40.9 dB (High)                      |
| JPEG                                             | 42.4 dB, edge error 2.4, 517 KB | **45.8 dB, edge error 1.5**, 645 KB |

The refine costs one keyframe per still period: 499 KB at 6 Mbps and 246 KB at the slower
links for this worst-case window (real windows are mostly flat and far smaller), encoded in
10–22 ms. At 1.2 Mbps a fully changing 1600×1000 window still drops most motion frames;
viewers at that budget negotiate smaller sizes.

**HEVC** (VideoToolbox, same harness) was 1.5–2.5 dB better than H.264 High at equal bitrate
(41.0 vs 40.9 dB moving at 6 Mbps; refine at QP 16: 48.3 vs 44.7 dB). It is not adopted:
Firefox and many non-Apple WebCodecs decoders cannot play it, and the wire's codec enum is
H.264 only (#1129 owns the wire). Refine on idle closes most of the gap for still text.

## Live view latency

`node packages/screen/bench/live-view.ts` starts a real helper session on Calculator's window
(H.264, 60 fps, 6 Mbps), presses Calculator's digit buttons through the engine and records the
time to the first encoded frame on the frame socket, frame rate, bytes on the wire, refine
cost and helper CPU. **Not measured in this revision:** during the work the person's Mac was
on a full-screen Space, and ScreenCaptureKit delivers no new frames for a window on another
Space, so presses produced no frames. The run confirmed the startup sequence instead: before,
a 674×408 pt window sent one JPEG and then nothing after negotiating H.264 (an idle window
has no damage); after, it sent a 1348×816 (2x, shadow-free) H.264 keyframe and a 57 KB refine
300 ms later. Input → pixel, fps and CPU **need a run with the target window on the current
Space** (`ACE_COMPUTER_HELPER=… node packages/screen/bench/live-view.ts 20`). The encoder
changes do not add work per moving frame (one fewer copy, same session settings).

## Agent action latency

`node packages/screen/bench/computer-actions.ts 12` runs a fixed Calculator sequence through
the real toolkit and helper, 12 rounds after a cold one, p50 / p95 per step. "Before" is main
rebuilt and signed the same way (a freshly signed helper was measured slower on screenshots for
a few minutes on this Mac, so both builds were fresh).

| Step (Calculator)                            | Before p50 / p95 | After p50 / p95 |
| -------------------------------------------- | ---------------: | --------------: |
| `screen_act` click by id (observed)          |     217 / 257 ms |    104 / 108 ms |
| `screen_act` Escape + type `12+34=`          |     392 / 406 ms |    275 / 281 ms |
| `screen_act` click, `observe: false`         |        5 / 14 ms |        4 / 5 ms |
| `screen_state` look (unchanged)              |         5 / 7 ms |        5 / 7 ms |
| `screen_state` look + screenshot             |       58 / 91 ms |      53 / 68 ms |
| `screen_state` screenshot only               |       33 / 35 ms |      32 / 35 ms |
| `screen_act` key with no effect + screenshot |     265 / 267 ms |    255 / 260 ms |
| Whole sequence (sum of p50s)                 |           980 ms |          733 ms |

A walk of Calculator's 68 elements after an action took 86 ms before and 56–68 ms after
(median of 20 under load 17), with action-name reads gone (11 ms → 0). An action the app does
not react to (Escape on a cleared display) still waits the full quiet interval: silence is
the only signal that nothing is coming.

TextEdit was not measured: a document the benchmark opens lands on another Space than the
person's, and the engine cannot reach a new window there yet (the paused off-Space work).

## Reproduce

```sh
sh native/screen-helper/build.sh
sh native/screen-helper/bench-stream.sh                       # sharpness, no permissions needed
ACE_COMPUTER_HELPER=$PWD/native/screen-helper/build/ace-screen-helper node packages/screen/bench/computer-actions.ts 12
ACE_COMPUTER_HELPER=$PWD/native/screen-helper/build/ace-screen-helper node packages/screen/bench/live-view.ts 20
```

The last two operate Calculator (and only Calculator) and need the helper's Accessibility and
Screen Recording permissions.
