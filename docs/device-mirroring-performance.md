# Device mirroring performance

The Devices panel negotiates a bounded H.264 stream for WebCodecs-capable viewers. The macOS helper uses VideoToolbox's required hardware encoder, realtime mode, H.264 High at level 5.1 and no frame reordering; a picture that holds still for 300 ms is re-sent once as a refined keyframe ([computer-use-performance.md](computer-use-performance.md)). Android uses the scrcpy server's H.264 from the device's own encoder, passed through without ffmpeg (see the Android section below); the screenrecord fallback still decodes to JPEG through ffmpeg. JPEG remains the default for clients that do not negotiate video, unsupported decoders, screenshots and Devices recordings.

The helper retains one outstanding encode, its latest captured image and one replaceable changed image. Encoder completion submits that last changed image even when the source has become idle. Its existing frame writer keeps one partially written packet and one replaceable pending packet. Daemon, relay and client frame hubs retain one in-flight frame and one replaceable pending frame per consumer. Preview packets stop being admitted above 128 KiB of buffered data. Screenshot packets use a separate reliable operation which explicitly rejects congestion rather than reporting success without pixels. A missing video sequence invalidates dependent deltas; the decoder requests a self-contained IDR with parameter sets and retries once per second if it is lost while the source becomes idle. Decoder errors or a 500 ms output timeout negotiate JPEG. Hidden/unmounted views close decoding and release images; visibility recovery requests a fresh frame, including for an idle simulator.

Panel dimensions (physical pixels, capped at 2× device pixel ratio in the web panel), connection and decode pressure set even capture dimensions and bitrate. Local budgets allow 60 fps / 6 Mbps; remote allows 30 fps / 2.5 Mbps; relay allows 30 fps / 1.2 Mbps with a smaller panel limit. Pressure lowers resolution and bitrate, with gradual recovery after ten quiet seconds. Shared capture takes the smallest viewer budget and switches to JPEG if any viewer requires it. Screenshots and recordings hold shared image leases without increasing that budget; completion, quota, error and startup failure release the leases. Disconnected connections cannot insert preferences after asynchronous session lookup. Android screenrecord does not expose an FPS setting or a live IDR request: video bitrate/size negotiation restarts that owned capture, and IDR requests rate-limit those restarts to once per second.

Simulator pointer down/up are sent immediately. Pointer moves retain one outstanding request and the latest position. A local cursor marker follows input before captured pixels arrive. Android keeps its existing tap/swipe gesture UI. Every input still goes through approval, controller lease and dispatch guards; controller changes and lease expiry cancel a held native pointer, even when no further input arrives. An injected timer follows renewed deadlines and is cancelled on disconnect/stop. Window routing verifies the current window owner/bounds and onscreen same-app windows above it, while avoiding full-desktop enumeration and repeated expensive ScreenCaptureKit discovery on each move. Keys retain focus validation.

## Reproduce on macOS (merge-time only)

The owner prohibits tests, probes and benchmarks during feature work. The commands below are instructions for the merge-time verifier; they were not run in this revision.

Requirements: Xcode's Simulator SDK/runtime (iPhone 16 / iOS 18+), Bun, Node 26+, the repo's Playwright Chromium, and Screen Recording / Accessibility permission for the launching terminal. Run from any directory:

```sh
/absolute/path/to/ace/tools/web-perf/device/run.sh > after.json
ACE_PERF_ASSERT=1 /absolute/path/to/ace/tools/web-perf/device/run.sh > after.json
```

The wrapper creates `ace-perf`, boots only its new UUID, installs a tiny clock/tap-ack app, opens that device's Simulator window and launches a daemon with a unique temporary `ACE_HOME`. It disables provider discovery/model instances. Its trap shuts down/deletes only that UUID and removes only that temporary directory. It never reads or writes `~/.ace-next`. Helper builds are explicit; do not run another helper build concurrently. Use `ACE_PERF_HELPER=/absolute/path/to/a/built/helper` to skip the build, `ACE_PERF_RUNTIME` to select a runtime, or `ACE_PERF_FPS` to select the requested capture cadence.

For comparison, build the JPEG helper from the PR #124 base (`9c18d5a1`) in a separate checkout, then run the current harness with its executable:

```sh
ACE_PERF_BASELINE=1 ACE_PERF_HELPER=/absolute/path/to/old/native/screen-helper/build/ace-screen-helper \
  /absolute/path/to/ace/tools/web-perf/device/run.sh > before.json
```

Baseline mode requests the original 10 fps and uses image decode/draw and tap input. Video mode uses the production authenticated device transport, WebCodecs renderer and immediate pointer-down/up. The script is intentionally outside the default check gate because it boots a simulator and needs macOS permissions.

The source app paints a 32-bit millisecond clock and toggles a pixel acknowledgement on each tap. The harness counts canvas presentation opportunities at requestAnimationFrame after warm-up and sends sixteen taps. It reports capture-header → canvas presentation and source-pixel clock → canvas presentation separately, FPS, binary bytes including headers, input-request → changed pixel, input dispatch duration, helper/daemon/Chromium-renderer CPU, negotiated codecs and resolution. CPU is normalized to one core (100% = one core), using CPU-time deltas; daemon CPU includes the Node harness, and renderer CPU includes the clock readback. These are headless canvas/rAF measurements, not physical display scanout or photon measurements. Android timestamps currently start at daemon receipt, so Android capture latency needs a source-clock benchmark before making equivalent latency claims.

## iOS through serve-sim (2026-10-19, #1102)

With a pinned serve-sim, H.264 viewers receive serve-sim's own VideoToolbox stream
(High 5.1, native framebuffer size) re-framed as Annex B; the daemon neither decodes
nor re-encodes. Measured on this Mac (Apple Silicon, Xcode 26.6, iPhone 16 Pro on
iOS 26.5, 1206×2622, host load average 5–9) with the perf probe app from
`tools/web-perf/device/Probe.swift`, which redraws a clock every display frame and
toggles a colour cell on each tap. A script drove `simulatorCapture` directly: 30 taps
at random 450–750 ms intervals, frames timestamped on arrival at the daemon, and the
first frame whose decoded cell shows the toggled colour gives input → pixel. This
stops at the daemon: WebCodecs decode and canvas paint are not included (Electron 44's
Chromium decoded 120 of these frames, `avc1.640033` without a description, in 159 ms
including setup).

| Path (serve-sim 0.1.48)             | Input → pixel p50 / p95 |  fps |      Wire | serve-sim CPU | daemon CPU |
| ----------------------------------- | ----------------------: | ---: | --------: | ------------: | ---------: |
| H.264 passthrough                   |             35 / 110 ms | 59.1 | 0.55 Mbps |           46% |         1% |
| MJPEG + sharp resize (old path)     |             53 / 106 ms | 57.2 | 19.3 Mbps |           79% |       164% |
| H.264 passthrough, serve-sim 0.1.47 |             36 / 115 ms | 57.3 | 0.51 Mbps |           49% |         1% |

CPU is percent of one core from CPU-time deltas over the run. The probe redraws the
whole screen every frame, which is serve-sim's worst case; on a static Settings screen
its H.264 stream costs 5.5% (MJPEG 8%) and nothing when no one subscribes. The p95 tail
is two or three taps per run that landed during a keyframe or a host stall. The old
ScreenCaptureKit path's 106–137 ms below was measured with a different harness (canvas
in a browser) and is not directly comparable, but both runs start the clock at input
dispatch and use the same probe.

## Historical measurements on this Mac

These measurements predate review fixes and the merge of main. They describe revision `2d9e1a0d`, are preserved unchanged, and have not been independently reproduced. Current latency, FPS, bandwidth, CPU and RSS **need run at merge**.

Apple M4 Max, 16 cores, 128 GB; iPhone 16 / iOS 18.5. Initial measurements on 2026-10-04 used the same disposable simulator window and source app. JSON reports are retained in [perf/device-stream](perf/device-stream). The initial probe sampled canvas commits immediately; its latency field named `captureToDisplayMs` measures the source pixel clock (including app drawing/capture), rather than only the helper header. The final harness additionally measures headers and waits for rAF.

| Metric                          | Original JPEG | Final hardware H.264 |
| ------------------------------- | ------------: | -------------------: |
| Displayed fps                   |          9.96 |                41.12 |
| Source pixel → canvas p50 / p95 |    27 / 33 ms |           25 / 33 ms |
| Input → pixel p50 / p95         |  202 / 250 ms |         106 / 140 ms |
| Binary bandwidth                |     2.93 Mbps |            0.31 Mbps |
| Helper CPU                      |         4.78% |               12.02% |
| Daemon CPU                      |         1.70% |                3.45% |
| Renderer CPU                    |         4.34% |               10.48% |

The final immediate down/up run (`after-final.json`) passed `ACE_PERF_ASSERT=1`: 48.44 fps, capture-header → rAF p50 6.27 ms / p95 20.64 ms (579 samples), source-pixel → rAF p50 27 ms, and input → pixel p50 115 ms (16 acknowledgements). It reduced bandwidth about 87% from the original 10 fps JPEG baseline. The final run had no other ace checks running alongside it, although external host load remained extreme (around 400). Helper plus daemon used 22.91% of one core, approximately 1.43% of this 16-core machine. The initial intermediate H.264 run is also retained as `after-initial.json` (41.12 fps / 106 ms input p50). 60 fps is enabled; sustained 60 fps has not been established on this busy host. These results do not establish physical-display latency, Android performance, relay throughput or production-workload CPU costs.

A later baseline rerun during extreme host contention (load average peaked above 580) fell to 5.72 fps, source-pixel latency p50 52 ms / p95 601 ms and input latency p50 770 ms / p95 7305 ms. Its full JSON is retained as `before-contention.json`. The immediate pointer-phase rerun (`after-contention.json`) still displayed 43.80 fps, capture-header → rAF p50 10.40 ms / p95 29.31 ms, source-pixel → rAF p50 31 ms / p95 64 ms and 0.35 Mbps, but missed the input target at p50 217 ms / p95 302 ms. Helper/daemon/renderer CPU was 17.71% / 4.38% / 8.61%. Its daemon shutdown also exceeded the existing 8 s cleanup deadline; the harness now explicitly stops owned capture before closing the daemon. Restricting the geometry query to the target and onscreen windows above it (`after-geometry.json`) improved displayed cadence to 50.24 fps, capture-header → rAF p50 4.63 ms / p95 16.97 ms and source-pixel → rAF p50 26 ms / p95 39 ms; input p50 improved to 137 ms / p95 179 ms but still missed the 120 ms target under contention. Bandwidth was 0.37 Mbps; helper/daemon/renderer CPU was 16.77% / 4.57% / 9.13%. The final refinement removes a duplicate permission query, retaining permission verification immediately before every posted event, and passes all three local assertions as reported above. Report repeat measurements with host load; do not compare the low-contention initial run directly with an oversubscribed run or relax the targets to hide contention.

## Android emulator through scrcpy (2026-10-19)

Measured on an Apple M4 Max (16 cores), host load average 4–12, with a headless `Ace_Pixel_Spike` AVD (API 36, arm64, 1080×2400, `-no-window`). The daemon side ran ace's own scrcpy client against the pinned scrcpy-server v5.0.1. Probes are throwaway scripts; the opt-in `scrcpy.live.process.test.ts` repeats the functional checks (`ACE_DEVICE_LIVE=1 ACE_DEVICE_LIVE_ANDROID_SERIAL=<serial>`).

| Metric                                                           | scrcpy H.264 (new) | scrcpy → ffmpeg JPEG (images) | screenrecord → ffmpeg JPEG (fallback) |
| ---------------------------------------------------------------- | -----------------: | ----------------------------: | ------------------------------------: |
| Key input → first new frame at the daemon, p50 (range), 8 runs   |     57 ms (28–108) |                         55 ms |                         68 ms (58–90) |
| Emulator (qemu) CPU during 10 s of swipes; 447 % with no capture |              520 % |                         553 % |                                 538 % |
| ffmpeg CPU                                                       |               none |                          31 % |                                  33 % |
| Daemon (Node) CPU                                                |              0.4 % |                         0.7 % |                                 0.7 % |
| Bandwidth at 1080 wide, 8 Mbps cap                               |           5.6 Mbps |                     14.1 Mbps |                             13.6 Mbps |

- Input → frame is measured from the control message to the first packet the daemon receives after an idle screen. It includes the device's composition and encode, not the viewer's decode or display. scrcpy repeats an idle frame now and then, so the low end of each range is noisy.
- CPU is one core = 100 %. The emulator's own cost dominates and is noisy on a shared host; the clear differences are that the H.264 view runs no ffmpeg and that its stream is less than half the bytes.
- Start-up: 370–420 ms to a running capture with a cached jar (about 1 s on first use, including the download and checksum), and the first keyframe about 480 ms after the start request. A keyframe request (a video reset) produced a new IDR in about 40–60 ms.
- One capture streamed for 227 s through repeated swipes with no restart; scrcpy has no time limit.
- Typing `héllo 👋` into a contact field landed exactly (pasted through the clipboard; the action took 5–70 ms). Two fingers (`pointerId` 0 and 1) were tracked as two pointers by Android's pointer-location overlay.
- UI tree: ace's UiAutomation helper answered in 46–48 ms per read (173 ms for the first read, which pushes and starts it), against 2.0–2.04 s for `uiautomator dump`, both including ace's per-read emulator identity checks.

## Validation and follow-up

Deterministic fake-decoder tests cover dropped delta recovery, IDR demand, overload, decode errors/stalls, JPEG fallback and late output cleanup. Profile tests cover panel/network/pressure budgets; stream-control tests cover coalesced native reconfiguration, shared viewer budgets and concurrent screenshot JPEG leases. Pointer tests cover bounded move delivery and cancelling stale moves. Process tests exercise real local processes/sockets with fake provider boundaries, including Android video/image negotiation; existing device lifecycle, approval/lease, recording, input and renderer tests remain in the touched-test run.

Review follow-up is static only. `swift build`, formatting, lint, the 1,500-line limit, dependency checks and generated protocol checks pass. Dependency-cruiser warns that its TypeScript support excludes the installed TypeScript 7. The backend/client packages typecheck. Full-repository `bun run typecheck` fails at `apps/web/src/features/devices/device-tab.tsx:184`: the input callback can return an empty string, while `DeviceScreen` expects void or Promise<void>. Owner policy forbids Codex UI edits; this belongs to the Claude web agent.

No tests, benchmarks, probes, mutation/flakiness runs, combined check or CI were executed during the review corrections. Earlier successful tests and performance measurements apply only to the earlier revision. Fake H.264 payloads test transport/negotiation, not hardware encoding. Native tests with fake encoder/posting boundaries cover bounded pending images, permission revocation and retained failed release. Real overlap release, real encoding, decode/display and performance verification **need run at merge**.

The simulator performance harness remains outside the default gate. Remote throttled links, relay and a real Android emulator still require merge-time measurements. H.264 is selected; HEVC is not negotiated.

## UI follow-up for the Claude web agent

- Fix `device-tab.tsx:184` and its `use-devices.ts` input callback to always return void or Promise<void>, forwarding the actual acknowledgement from `DeviceClient.request({ op: "input", ... })` from `@ace/client/devices`. Re-run full static typecheck after that UI change.
- Keep canvas decoding through the web app's `pictureRenderer` (`apps/web/src/lib/video`, one renderer for every live view), profiles through `deviceStreamProfile`, ordered latest moves through `coalescedPointerMoves` (discard pending motion before up/cancel), and lifecycle cleanup through renderer `close()`, frame-watch release and `DeviceClient.disconnect()`.
- Replace the 50 ms renderer-test sleep and no-op bitmap/draw stubs with observable decode/draw/close completion. Assert cursor/input ordering and reconnect/resize behavior at the actual renderer boundary. Those UI tests need run at merge.
- Optional connection/codec diagnostics may follow later. Wire relay connection budgets through the same public client APIs without introducing provider prompts.

Primary implementation references: [Apple compression properties](https://developer.apple.com/documentation/videotoolbox/compression-properties), [WebCodecs](https://www.w3.org/TR/webcodecs/), [AVC byte-stream registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/), [Apple window-list options](https://developer.apple.com/documentation/coregraphics/cgwindowlistoption/optiononscreenabovewindow). No third-party mirroring code was copied.
