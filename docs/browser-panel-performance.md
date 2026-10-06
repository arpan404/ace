# Browser panel performance

The daemon at `84773d6d` rewrote `browser.backend: auto` to `headless` before
BrowserService could choose a registered desktop backend. That bypassed the
native WebContentsView even when desktop registration succeeded. Preserve `auto`
so human opens use the embedded backend; explicit background opens remain headless.
Existing sessions keep their backend until closed and reopened.

A packaged-layout Electron test uses an isolated home, real desktop credential and
socket registration, bundled main/preload and production renderer. With no working
headless executable, an auto open succeeds through the embedded backend. A 600×400
CSS placement yields at least 1200×800 native PNG pixels at DPR 2, stays above the
renderer image, and handles native clicks and wheel scrolling under human control.
The test uses a local animation page and no external websites.

## Fallback measurement

`node packages/browser/bench/crisp.ts` launches an isolated diagnostic Chromium
context and a local HTTP page with a CSS animation and a clickable color marker.
A second page decodes each JPEG into a canvas before acknowledging it. After
2.5 seconds of warmup it samples four seconds of delivered frames, then reports
the median of eight CDP click-to-decoded-red-pixel measurements. Each click waits
for a decoded blue reset first. Timings exclude daemon command and viewer
WebSocket routing, and are not native compositor latency measurements.

For the baseline, the same harness imports `live.ts`, `fanout.ts`, `cdp.ts` and
`backend.ts` from our own `84773d6d` revision in a disposable directory and runs
with `ACE_BENCH_DPR=1`. The new capture runs at DPR 2, sizes the headless compositor
as well as the emulated CSS viewport, and reports a local 1280×720 DPR-2 viewer.
Temporary baseline files are removed after the comparison.

These paired samples were collected under extreme unrelated host contention.
They establish the encoded raster change, but cannot establish a timing gain.

| Measure                          |   Before |     After |
| -------------------------------- | -------: | --------: |
| Starting one-minute host load    |   348.70 |    354.49 |
| Encoded JPEG raster              | 1280×633 | 2560×1440 |
| Mean JPEG bytes                  |    8,727 |    32,398 |
| Delivered fps                    |      2.7 |       2.2 |
| Median input-to-decoded-pixel ms |    182.7 |     205.2 |

Raw samples: [before](perf/browser-panel/before-contention.json),
[after](perf/browser-panel/after-contention.json). The old headless compositor
cropped the CSS viewport; sizing its contents fixes that independently of DPR.
The real-Chromium behavior test verifies the full 2560×1440 encoded raster and
1280×720 CSS input metadata, then verifies that remote DPR-4 demand remains capped
at 1280×720.

Local fallback targets JPEG 90 and 30 fps, capped at 2560 on the long edge. Remote
fallback targets JPEG 80 and 15 fps, capped at 1280. Sustained unacknowledged or
refused frames degrade capture to JPEG 40 and 6 fps, and recovery restores quality.
The adaptation test checks actual JPEG quantization and delivered frame cadence.
The existing one-in-flight plus replaceable-latest frame bounds and ACKs remain.
Viewer demand survives tab replacement and socket reconnect without taking control
or changing the controller's CSS viewport.

The device H.264 path consumes a native encoder's already encoded Android
screenrecord stream. CDP browser screencast produces JPEG/PNG frames. Reusing the
device decoder would require another browser-side encoding process, adding cost
and latency without recovering lost raster detail. This change keeps JPEG and
fixes native selection, compositor sizing, viewer demand and adaptive delivery.
