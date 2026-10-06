# Device stream benchmark

`node tools/web-perf/device/check.ts` is wired into `check:perf`. It skips when Xcode,
an available iOS runtime, or an idle host (load below 15) is unavailable. A skip is
not a performance pass. On an idle Mac it creates a disposable Simulator, installs
a tiny animated UIKit probe, builds the real daemon and production Electron bundles,
and opens the actual Devices canvas through Playwright `_electron`.

The packaged run uses an ad-hoc signed copy of the installed Electron runtime,
`app://` and the production CSP, preload and hardware flags. Only OS installation
side effects (protocol/login-item registration) are disabled in that disposable
package. Its ace home, Electron profile, probe and Simulator are temporary. The
wrapper removes its own device on exit; it never chooses an already booted device.
No provider CLI sessions run.

The probe renders a millisecond clock and a colour acknowledgement in pixels.
The meter reads the actual Devices canvas after an animation frame. It reports
source-to-canvas latency, capture-to-canvas latency, displayed fps, observed wire
codecs, canvas/CSS/DPR dimensions, and dispatch-to-visible-acknowledgement latency
for ten taps, swipes and typed inputs. Input timing starts when the UI dispatches
its real WebSocket operation, excluding Playwright actionability waits. Frame
instrumentation observes the existing binary stream; it does not replace the
renderer or introduce another frame transport. Capture latency uses the latest
received frame timestamp and is diagnostic; the source pixel clock is the primary
latency measure.

Budgets: at least 45 displayed fps; source p50/p95 at most 60/120 ms; each input
kind p50/p95 at most 160/250 ms with at least eight acknowledgements; no failed
operations; H.264 after warm-up; canvas dimensions at least CSS size × full DPR
(with two pixels for encoder alignment). The product requests 60 fps and may
reduce cadence under pressure while keeping local pixel density.

For an explicit investigation run, including a busy-host result:

```sh
ACE_PERF_DRIVER=electron ACE_PERF_PACKAGED=1 ACE_PERF_REBUILD=1 \
  ACE_PERF_OUTPUT=/tmp/device-perf.json sh tools/web-perf/device/run.sh
```

Set `ACE_PERF_ASSERT=1` to enforce budgets, `ACE_PERF_SPACE=1` to put the disposable
ace window in a full-screen Space, or `ACE_PERF_KEEP=1` to retain the sandbox.
`ACE_PERF_HELPER` can select a baseline helper. `ACE_PERF_BASELINE` is a legacy
10-fps experiment and does **not** represent main's #138 H.264 build.

Simulator typing, Enter, Home and Lock use idb's native device HID when idb is on the daemon PATH;
its companion must target the disposable UDID. Without idb, background Mac keyboard events are unsupported on the tested Xcode
version: the helper returns `foreground_required` rather than acknowledging lost
text or activating another device. Its foreground keyboard route verifies the
selected window. Agents never steal desktop focus; unsupported background interactions return
`foreground_required`. This benchmark deliberately fails an unacknowledged input.

Android is an explicit opt-in: start your own read-only emulator on an unused
port, then run `android-probe.sh` with `ACE_PERF_ANDROID_SERIAL` set to that serial.
Run `electron.ts` with a temporary `ACE_HOME`, `ACE_PERF_DEVICE_NAME` naming that
AVD, the same serial, and `ACE_PERF_PACKAGED=1`. The probe requires Android SDK 36
build tools and Java 17 (override `ANDROID_HOME`/`JAVA_HOME`). Android's pixel clock
is calibrated against five adb clock reads; the minimum-RTT offset and uncertainty
are included in the result. Shut down only your own emulator afterward.

## Investigation on 84773d6d

The host was heavily loaded throughout these runs (one-minute loads 141–258 in the
reported samples), so these are functional and stressed-host measurements, not
comparable idle performance passes. Both connected displays had DPR 1; DPR 2/3
and tall portrait sizing are covered by behaviour tests rather than a Retina run.
Raw summaries are in [results](results).

| Actual production Devices view     |         fps | Source p50/p95 |        Tap p50/p95 |      Swipe p50/p95 |       Type p50/p95 |
| ---------------------------------- | ----------: | -------------: | -----------------: | -----------------: | -----------------: |
| Original helper, packaged          | interrupted |       27/51 ms | no acknowledgement | no acknowledgement | no acknowledgement |
| After, iOS + native idb HID        |        29.3 |       34/46 ms |         176/210 ms |         200/220 ms |         262/365 ms |
| After, ace in another Space        |        29.9 |       34/49 ms |         198/213 ms |         184/221 ms |         261/307 ms |
| After, Android, severe VM pressure |        17.0 |     201/607 ms |         208/244 ms |         233/239 ms |         351/395 ms |

The original helper ended the Devices view on the first input; its reported
0.65 fps includes the ensuing 30-second locator timeout and is not a throughput
baseline. A separate original-stack pixel-clock run before the actual UI harness
measured 43.5 fps and 27/37 ms source latency, then rejected the first input after
3,882 ms. No baseline input-to-pixel percentile exists because inputs failed.
The fix is input correctness and preserving resolution/recovery, not replacing
an assumed JPEG codec: main already negotiated H.264 successfully.

The iOS regular/Space runs each acknowledged all ten inputs of every kind, with
zero errors and zero JPEG frames during measurement. The regular canvas was
328×700 for CSS 327.77×699.48 at DPR 1. Hardware VideoToolbox encoding is required
by the helper and produced real H.264 frames; packaged WebCodecs decoded them
with `video_decode: enabled`. The Android run acknowledged four of each input
before an acknowledgement timeout under severe emulator pressure; its clock
uncertainty was 17.5 ms. Its ANR episodes prevent an idle-quality conclusion.

Root causes addressed: #152's agent focus guard was applied to human Simulator
control; CG window enumeration used an invalid relative window with `.optionAll`;
local pressure and a DPR cap reduced resolution; decoder scheduling stalls and corrupt-frame errors
permanently negotiated JPEG; Android spawned adb per input; and a recoverable
ScreenCaptureKit interruption exited the helper. Existing FrameHub, VideoToolbox,
WebCodecs and latest-frame queues are shared with the current streaming stack.
The browser worker's `fix/browser-crisp-native` worktree was read for coordination;
its physical-pixel sizing agrees with this stream contract.

The daemon benchmark passed after load fell to 13.19: idle RSS was 216.7 MiB
against its 256 MiB budget. An idle device run is still required to qualify
45+ fps and the input budgets. The owner's live check should cover their Simulator/Xcode
version, their permission state, idb/idb_companion installation for background typing, a Retina display, and Space
changes. The sandbox Space run did not terminate capture, but it did not induce
an actual ScreenCaptureKit system-interruption error; restart eligibility is also
covered by native behaviour tests.

Helper-only background typing was explicitly tested and refused with
`foreground_required`; it remains a tooling requirement, not a passing result.
