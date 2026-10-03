# Device verification at merge

Implementation checks are static only under the owner's current rule. Do not run
this plan, test suites, benchmarks or provider probes before merge authorization.
No fixture recording or provider prompt is needed for this plan.

## Automated behavior coverage

- Fake SDK executables discover AVDs and Simulator inventory without adb on PATH.
- Lifecycle tests boot, wait for readiness, install, launch and shut down the
  selected device, including paths and URLs containing shell metacharacters.
- Input tests map target points, timed gestures, hardware keys and rotation, and
  reject unsupported text instead of sending corrupted text.
- Ownership tests reject another thread/agent, expiry, disconnect, takeover and
  revocation, including actions queued behind a blocked command or SDK lookup.
- Log tests bound tails, batches and oversized native lines, and stop the owned
  process when its consumer closes.
- Stream tests exercise fragmented headers/payloads, independent slow viewers,
  latest-frame replacement, malformed packets and reconnect without input replay.
- Relay tests use real encrypted host/client channels and persisted pairings.
  They cover frames larger than one relay record, simultaneous streams and
  screenshots, read-only denial, identity mismatch and revocation.
- MCP tests exercise the actual HTTP registry, per-session credentials and all
  provider adapters using fake installed CLIs. No provider is prompted.
- Recording tests check frame timing, bounded reads, source validation, ffmpeg
  errors, cleanup and downloadable artifact metadata.

All execution results need run at merge. The intended commands remain
`bun run test`, never `bun test`, and the repository's full `bun run check` only
when the owner permits them.

## Manual local and remote plan

1. Use full Xcode on macOS. Build the screen helper and configure
   `ACE_SCREEN_HELPER`. Grant it Screen Recording and Accessibility. Install
   Android SDK Platform Tools and Emulator into `~/Library/Android/sdk`; leave
   adb off PATH to exercise absolute resolution. Put ffmpeg on the daemon PATH.
   Configure `ACE_WORKSPACE_ROOT` for recording artifacts.
2. Mount `mountDevicePanel` in the web/Electron host with a `DeviceClient`
   transport. For phone testing, mount a native renderer for the same portable
   client and use a paired relay channel whose hello selects `devices`. Those
   application hosts do not exist in this branch, so this mounting step is an
   integration prerequisite, not a completed manual result.
3. Refresh inventory. Remove one SDK temporarily and confirm the other platform
   still appears alongside a typed install hint. With both absent, confirm a
   typed SDK error. Restore SDKs. Check offline and unauthorized adb transports
   never become input targets; close duplicate processes for the same AVD.
4. Enable devices, select a shut down device, take control, boot it and refresh.
   Open its Simulator window on iOS. Start live view and confirm the first frame
   arrives before state becomes live. Install a Simulator-built `.app` or an
   emulator-compatible `.apk`, launch its app ID and open a URL and a deep link.
   Confirm `.ipa` and unsupported locale requests show their fix hints.
5. Approve the device for a real thread and delegate to an agent. Use only the
   ace MCP HTTP client to call tools with that agent's credential; do not send a
   prompt to a provider CLI. Verify tree/find/act, screenshot, tap, long press,
   swipe, text, home and rotation. Android semantic actions must report fallback
   and reject refs after the target changes. Check portrait and landscape
   coordinates against the displayed frame scale, including scaled frames.
6. Take control from the agent during a queued action. Confirm later queued
   input fails and human input controls the device. Let the lease expire and
   confirm input needs renewed control. Revoke thread approval and confirm the
   agent cannot inspect or act. Revoke the paired phone credential during frame
   transfer; its channel closes and control is released.
7. View two devices from independent relay channels. Stall one viewer, then
   generate many visual changes. Resume it and confirm it receives the latest
   image while the other viewer remains responsive. Request screenshots while
   streaming and confirm packets stay intact. Check static images stop producing
   frames and Android source restarts after the 180-second native boundary.
8. Rotate Android repeatedly during capture. Confirm the decoder restarts,
   dimensions and scale update, and taps still hit their displayed target. Repeat
   with long press and swipe durations on iOS. Check different Simulator models
   and runtimes; ambiguous windows must fail rather than capture another device.
9. Start logs locally and through `device_logs`. Generate more than 256 lines,
   stall a subscriber and verify bounded tail, dropped count and continued
   responsiveness. Stop logs and confirm the child process exits. Reconnect the
   client and confirm no input, approval or control is replayed.
10. Record changes separated by long static intervals, stop recording, and
    download the registered MP4 locally and through the relay. Confirm timing,
    playback, file metadata and the 50 MiB limit. Disconnect or stop capture
    during recording and verify cleanup and retained artifact availability.
11. Open dedicated browser and screen relay channels. Verify existing browser
    origin/ownership rules and screen admin/approval rules. Check tool catalogs
    for Claude, Codex, Gemini, Cursor, OpenCode and OpenAI-compatible adapters
    with the fake CLI integration tests. ACP implementations without HTTP MCP
    support must produce a clear capability error.

## Opt-in native tests and measurements

`device.live.process.test.ts` skips unless `ACE_DEVICE_LIVE=1`. Lifecycle tests
also need an explicitly selected, initially shut down device through
`ACE_DEVICE_LIVE_IOS_UUID` or `ACE_DEVICE_LIVE_ANDROID_AVD`. The gesture test
requires macOS, `ACE_DEVICE_GESTURE_LIVE=1` and helper permissions. These tests
operate only on the named device or the dedicated test window.

When benchmark execution is permitted, record `packages/devices/bench/frames.ts`
and `packages/mcp-server/bench/credential-redaction.ts` output, including peak RSS.
For native capture, measure CPU, RSS, frame latency and bytes per changed frame
over a static interval, scrolling, rotation, two viewers and a blocked viewer.
Compare the chosen H.264 path to emulator gRPC on the installed emulator before
claiming it is the most efficient verified path. All numbers are currently
unmeasured and need run at merge.
