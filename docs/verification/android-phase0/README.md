# Android Phase 0 measurements

The Phase 0 gate remains held. End-to-end input latency passes on the accelerated
emulator, and SQLite restart replay passes. Scrolling improves substantially with
host GPU rendering, but the current and legacy frame metrics disagree. A bounded
five-minute memory observation does not certify long-run memory behaviour. This
report does not authorize advancing to the paired-device MVP.

## Environment

Measured October 12, 2026, on the shared Mac. One emulator and one Gradle build
ran at a time. Gradle used `--max-workers=4`; measurement began after it exited.
The arm64 debug APK uses Expo 57.0.27, React Native 0.86.3, Hermes, stable Expo UI
57.0.22, FlashList 2.0.2 and the merged `@ace/design-tokens`. Metro uses CI mode,
Fast Refresh off and four workers.

The accelerated run uses `Ace_OEM_Geometry`, Android API 36.1, 1080 x 2340,
450 dpi, text scale 1.3, four cores, 4 GiB RAM and host GPU rendering. The earlier
`Ace_Pixel_Spike` run used API 36, 1080 x 2400, 420 dpi, text scale 1.0 and
SwiftShader. Both are stock Android images. Geometry resembling another OEM
cannot prove One UI, Xiaomi or OnePlus runtime equivalence.

## End-to-end input

[Input observations](input.json) record the completed 120-key run against the
loaded 2,001-item streaming thread. The fixture produces 10 deltas per second.
The timestamp precedes Android InputManager enqueue, dispatch and IME processing.
Completion requires the React draft commit, an input draw and the matching
completed Android FrameMetrics frame. Physical key actuation and display scanout
are outside the measurement. This is an end-to-end software measurement, rather
than text-mutation-to-draw timing.

| Observation                  |                   Result |
| ---------------------------- | -----------------------: |
| Attempted keys               |                      120 |
| Captured completed frames    |                      120 |
| Coverage misses              |                        0 |
| Coverage                     |                     100% |
| Required coverage            | 95%, at least 114 of 120 |
| Captured-sample p95          |             56.171880 ms |
| Conservative all-attempt p95 |             56.171880 ms |
| Maximum                      |             66.818008 ms |

A missing FrameMetrics callback counts as a miss. The probe continues through all
attempts and rejects below 95% coverage. It fences a timeout on the UI thread so a
late callback cannot complete the next key. For the conservative all-attempt p95,
missing observations are assigned the 2,000 ms capture timeout. These assignments
are not measured latencies. The final result passes the 100 ms target with complete
coverage. Intermediate JS logs can precede a frame callback; only the final result
is used here.

The separate debug instrumentation APK gives adb-attributed input injection a
bounded ten-minute window. The product APK gains no injection permission, and
ordinary app launches reject injection. No input contents or credentials are logged.

## Streaming transcript and memory

Ten SDK pages of 200 historical rows produce 2,001 retained items, confirmed by
`AceSpikeHistory`. Each transcript row subscribes to its item key. The SDK cap is
2,200 for this stress run. The fixture periodically replaces its streaming paragraph
to keep the individual message bounded.

[Scroll observations](scroll.json) record 40 alternating 350 ms swipes over
15.350 seconds. The fixture advanced 152 ticks, 9.90 deltas per second.
[Raw accelerated frame statistics](oem-debug-gfxinfo.txt) preserve Android's output.

| Observation          | Accelerated debug | Earlier software debug |
| -------------------- | ----------------: | ---------------------: |
| Rendered frames      |               926 |                  1,050 |
| Current janky frames |          1, 0.11% |            416, 39.62% |
| Legacy janky frames  |       695, 75.05% |                    90% |
| Frame time p50       |             20 ms |                  34 ms |
| Frame time p90       |             23 ms |                  77 ms |
| Frame time p95       |             24 ms |                  97 ms |
| Frame time p99       |             27 ms |                 150 ms |
| Missed vsync         |                 0 |                    194 |

Frame time is not input latency. The accelerated result meets the current Android
frame deadline metric but exceeds a single 60 Hz frame interval in the legacy
metric. A release/profileable build and device measurement must resolve this before
claiming steady 60 fps. [Earlier frame statistics](pixel-debug-gfxinfo.txt) and
sanitized [renderer](pixel-anr-renderer.txt) and [text layout](pixel-anr-text-layout.txt)
ANR stacks preserve the software-renderer failure. Full device bug reports are not
committed.

[Memory observations](memory.jsonl) record six samples, one per minute, after
history loading, input measurement and scrolling. The same PID, 3669, retained
its loaded thread throughout. No builds, reloads, installs or theme changes ran
during the soak. The fixture advanced 2,957 ticks over 300.1 seconds.

| Minute | PSS, KiB |
| ------ | -------: |
| 0      |  662,335 |
| 1      |  677,289 |
| 2      |  689,276 |
| 3      |  676,736 |
| 4      |  686,391 |
| 5      |  697,451 |

The observed range is 646.8–681.1 MiB. The final sample is 35,116 KiB, 5.30%,
above the start. A collection-like drop occurred at minute three, but the final
two samples rose. This does not establish a stable plateau. The SDK retention
and streaming paragraph are bounded by construction; observed native/JS memory
still needs a longer profileable soak before the memory gate can pass.

## Offline send, process kill and SQLite replay

The debug-only `ace://spike/offline-send/r1` probe uses the app's Hermes client,
exclusive-transaction SQLite adapter and host/device namespace. It waits for readiness,
marks the client offline and awaits `enqueue` for `android-spike-r1`.

1. After SQLite persistence resolved, the outbox contained the ID and the daemon
   had admitted no matching command.
2. `am force-stop` killed the process. A SQLite copy queried after the kill still
   contained the ID.
3. With the daemon port reverse removed, a cold `ace://spike/replay/r1` launch loaded
   that ID before readiness. There was still no daemon admission.
4. Restoring the port produced an `acked` receipt, an empty outbox and exactly one
   matching admission in the fixture's public canonical snapshot.
5. A second cold launch preserved exactly one admission.

[Replay observations](replay.json) contain IDs and states without message contents
or tokens. The daemon stayed running throughout this experiment. Release builds
reject the fixture before creating SQLite or transport. Remote pairing and pinned
TLS are Phase 1 work; the debug network policy allows cleartext only to loopback,
and the release policy forbids cleartext everywhere.

## Visual evidence

| Profile                               | Inbox                                                        | Composer above keyboard                                            |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Pixel, 420 dpi / 1.0, API 36          | [Light](pixel-inbox-light.png), [dark](pixel-inbox-dark.png) | [Light](pixel-composer-light.png), [dark](pixel-composer-dark.png) |
| OEM geometry, 450 dpi / 1.3, API 36.1 | [Light](oem-inbox-light.png), [dark](oem-inbox-dark.png)     | [Light](oem-composer-light.png), [dark](oem-composer-dark.png)     |

The large-profile light composer contains the 120 benchmark characters. Its
height is capped, its caption wraps, and its controls remain above the keyboard.
Visual captures use host GPU rendering on both profiles, after performance sampling.
The earlier Pixel scrolling data used SwiftShader.

Native glyph measurements compare the actual RN input paint to the bundled Inter
asset using the same paint size. Pixel actual/bundled advance is 359/359 at 41 px;
large-profile advance is 490/490 at 56 px. Light foreground is `#0B0B0C`, dark is
`#F5F5F7`. All four captures report asset SHA-256
`29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`.
[Pixel light](pixel-font-light.json), [Pixel dark](pixel-font-dark.json),
[large-profile light](oem-font-light.json) and [large-profile dark](oem-font-dark.json)
record these observations. Compose typography uses the same bundled font asset.

[Token pixel counts](theme-pixels.json) read original screenshot pixels without
editing them. They confirm fixed white/light and `#0A0A0B`/`#1A1A1D` dark surfaces,
foregrounds and marker/label status colours. In light mode the working dot and label
have distinct marker/text colours; both expected RGB values occur in each profile.
This is rendered palette evidence, not a claim that every pixel must match across
font scales or densities.

[Inline approval](pixel-approval-light.png) records the native card and actions.
[Agents sheet](pixel-agents-light.png) shows a blocked root, idle explorer and
running background task while the thread remains Needs you.

The screenshots follow the approved mobile v2 direction: neutral surfaces, attention
colour on the inbox row, compact status labels and a floating composer. There is no
tab bar. Typography scales with the user's text setting. The large history and probe
controls are debug instrumentation. Physical OEM checks remain required for release.

## Reproduce and validation

See [the app instructions](../../../apps/android/README.md) for the bounded native
build, instrumentation runner, input probe and replay procedure. Use `dumpsys gfxinfo
<package> reset` before scrolling and collect `dumpsys gfxinfo <package>` afterward.
Collect `dumpsys meminfo <package>` and `pidof <package>` once per minute, plus the
fixture's `/metrics`, while leaving the loaded thread in one unchanged process.

All round-1 findings are addressed: ADR 0073, per-agent/task row subscriptions,
revision-guarded composer clearing with delayed-persistence behaviour tests for CI,
separate marker/text status colours, Android dependency-boundary coverage and native
cleartext restrictions. Main merged cleanly and protocol docs were regenerated.
No Vitest, root check or root typecheck ran locally. Scoped format/lint, Android
package typecheck and the bounded native build are the local validation scope.
