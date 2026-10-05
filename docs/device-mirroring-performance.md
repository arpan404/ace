# Device mirroring performance

The Devices panel negotiates a bounded H.264 stream for WebCodecs-capable viewers. The macOS helper uses VideoToolbox's required hardware encoder, realtime mode, Baseline H.264 and no frame reordering. Android retains screenrecord's hardware H.264 output; ffmpeg inserts access-unit delimiters without decoding/re-encoding pixels. JPEG remains the default for clients that do not negotiate video, unsupported decoders, screenshots and Devices recordings.

The helper retains one outstanding encode, its latest captured image and one replaceable changed image. Encoder completion submits that last changed image even when the source has become idle. Its existing frame writer keeps one partially written packet and one replaceable pending packet. Daemon, relay and client frame hubs retain one in-flight frame and one replaceable pending frame per consumer. Preview packets stop being admitted above 128 KiB of buffered data. Screenshot packets use a separate reliable operation which explicitly rejects congestion rather than reporting success without pixels. A missing video sequence invalidates dependent deltas; the decoder requests a self-contained IDR with parameter sets and retries once per second if it is lost while the source becomes idle. Decoder errors or a 500 ms output timeout negotiate JPEG. Hidden/unmounted views close decoding and release images; visibility recovery requests a fresh frame, including for an idle simulator.

Panel dimensions (physical pixels, capped at 2× device pixel ratio in the web panel), connection and decode pressure set even capture dimensions and bitrate. Local budgets allow 60 fps / 6 Mbps; remote allows 30 fps / 2.5 Mbps; relay allows 30 fps / 1.2 Mbps with a smaller panel limit. Pressure lowers resolution and bitrate, with gradual recovery after ten quiet seconds. Shared capture takes the smallest viewer budget and switches to JPEG if any viewer requires it. Screenshots and recordings hold shared image leases without increasing that budget; completion, quota, error and startup failure release the leases. Disconnected connections cannot insert preferences after asynchronous session lookup. Android screenrecord does not expose an FPS setting or a live IDR request: video bitrate/size negotiation restarts that owned capture, and IDR requests rate-limit those restarts to once per second.

Simulator pointer down/up are sent immediately. Pointer moves retain one outstanding request and the latest position. A local cursor marker follows input before captured pixels arrive. Android keeps its existing tap/swipe gesture UI. Every input still goes through approval, controller lease and dispatch guards; controller changes and lease expiry cancel a held native pointer, even when no further input arrives. An injected timer follows renewed deadlines and is cancelled on disconnect/stop. Window routing verifies the current window owner/bounds and onscreen same-app windows above it, while avoiding full-desktop enumeration and repeated expensive ScreenCaptureKit discovery on each move. Keys retain focus validation.

## Reproduce on macOS (merge-time only)

The owner prohibits tests, probes and benchmarks during feature work. The commands below are instructions for the merge-time verifier; they were not run in this revision.

Requirements: Xcode's Simulator SDK/runtime (iPhone 16 / iOS 18+), Bun, Node 24+, the repo's Playwright Chromium, and Screen Recording / Accessibility permission for the launching terminal. Run from any directory:

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

## Validation and follow-up

Deterministic fake-decoder tests cover dropped delta recovery, IDR demand, overload, decode errors/stalls, JPEG fallback and late output cleanup. Profile tests cover panel/network/pressure budgets; stream-control tests cover coalesced native reconfiguration, shared viewer budgets and concurrent screenshot JPEG leases. Pointer tests cover bounded move delivery and cancelling stale moves. Process tests exercise real local processes/sockets with fake provider boundaries, including Android video/image negotiation; existing device lifecycle, approval/lease, recording, input and renderer tests remain in the touched-test run.

Review follow-up is static only. `swift build`, formatting, lint, the 1,500-line limit, dependency checks and generated protocol checks pass. Dependency-cruiser warns that its TypeScript support excludes the installed TypeScript 7. The backend/client packages typecheck. Full-repository `bun run typecheck` fails at `apps/web/src/features/devices/device-tab.tsx:184`: the input callback can return an empty string, while `DeviceScreen` expects void or Promise<void>. Owner policy forbids Codex UI edits; this belongs to the Claude web agent.

No tests, benchmarks, probes, mutation/flakiness runs, combined check or CI were executed during the review corrections. Earlier successful tests and performance measurements apply only to the earlier revision. Fake H.264 payloads test transport/negotiation, not hardware encoding. Native tests with fake encoder/posting boundaries cover bounded pending images, permission revocation and retained failed release. Real overlap release, real encoding, decode/display and performance verification **need run at merge**.

See [device stream review coverage](testing/device-stream-review.md) for every review item and the mutation plan. Each mutation case is **not executed (tests run at merge)**. The simulator performance harness remains outside the default gate. Remote throttled links, relay and a real Android emulator still require merge-time measurements. H.264 is selected; HEVC is not negotiated.

## UI follow-up for the Claude web agent

- Fix `device-tab.tsx:184` and its `use-devices.ts` input callback to always return void or Promise<void>, forwarding the actual acknowledgement from `DeviceClient.request({ op: "input", ... })` from `@ace/client/devices`. Re-run full static typecheck after that UI change.
- Keep canvas decoding through `deviceCanvasRenderer`, profiles through `deviceStreamProfile`, ordered latest moves through `coalescedPointerMoves` (discard pending motion before up/cancel), and lifecycle cleanup through renderer `close()`, frame-watch release and `DeviceClient.disconnect()`.
- Replace the 50 ms renderer-test sleep and no-op bitmap/draw stubs with observable decode/draw/close completion. Assert cursor/input ordering and reconnect/resize behavior at the actual renderer boundary. Those UI tests need run at merge.
- Optional connection/codec diagnostics may follow later. Wire relay connection budgets through the same public client APIs without introducing provider prompts.

Primary implementation references: [Apple compression properties](https://developer.apple.com/documentation/videotoolbox/compression-properties), [WebCodecs](https://www.w3.org/TR/webcodecs/), [AVC byte-stream registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/), [Apple window-list options](https://developer.apple.com/documentation/coregraphics/cgwindowlistoption/optiononscreenabovewindow). No third-party mirroring code was copied.
