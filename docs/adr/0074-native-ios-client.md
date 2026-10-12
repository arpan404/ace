# 0072: Native iOS client on the shared SDK through JavaScriptCore

Date: 2026-10-12. Status: Phase 0 implemented; smoothness gate not passed. Phase 1 held.
Amends [ADR 0003](0003-runtime-and-tooling.md). Refs #560.

## Decision and ownership

The requested iOS architecture is SwiftUI + shared `@ace/client` via JavaScriptCore.
`apps/ios/project.yml` generates an Xcode project targeting iOS 18+. Generated Xcode
files and JS bundles stay out of git. SwiftUI owns presentation. `ClientCore` owns
protocol parsing, connection epochs, reconnect, snapshots/replay, history admission,
durable sends and receipt persistence. Swift never derives thread completion.
Daemon whole-tree status reaches the native models through SDK readers. A completed
root with a working child still reads Working in the inbox and bridge contract test.

One JavaScriptCore VM lives on a dedicated thread with a run loop. Native socket,
storage and timer callbacks return to that thread. URLSessionWebSocketTask owns the
network boundary. Production targets require WSS and an exact SHA-256 DER SPKI pin;
the adapter hashes the certificate's SubjectPublicKeyInfo, matching the daemon's
format. It refuses redirects. Debug builds allow the loopback fixture only. Real
paired TLS and ticket exchange still need verification in Phase 1.

SQLite uses a serial I/O queue, WAL and FULL synchronous transactions. The SDK's
record write resolves after commit. Separate daemon/device databases retain an
immutable host binding. Tokens never enter the outbox. The spike uses a fixed fake
device credential; it implements no provider credential collection or storage.

The bridge retains changed keys and readers, with one acknowledged frame in flight.
Each frame is capped at 32 patches and 32 KiB UTF-8. Streaming changes update one
observable row. Membership changes send item/position changes without copying
unchanged text. Navigation generations reject stale patches, including reopening
the same thread. Leaving a thread cancels its outstanding SDK history reads.
The spike retains at most 2,200 items with SDK text bounds of 8,192 code units.
Snapshots still contain at most 200 items; the 2,000-item run hydrates through
`loadOlder`, exercising the SDK's page/delta journal.

`@ace/design-tokens` supplies the palette, typography metrics, spacing, radii,
dimensions, elevation, opacity and motion timing. The Swift generator validates the
raw JSON with `DesignTokensSchema` and has a reproducibility check. Dots use `status`;
labels use the AA-readable `statusText`. Native SF Pro/SF Mono and Dynamic Type
follow the issue's typography instruction. SwiftUI supplies navigation, lists,
menus, swipe actions, detent sheets, haptics and native materials. iOS 26 uses Liquid
Glass on the composer; iOS 18 uses the system material fallback. There is no tab bar.

## Phase 0 measurements

Xcode 26.6, iPhone 17 Pro simulator, iOS 26.5. One destination at a time, `-jobs 4`,
parallel testing disabled. FakeDaemon serves 2,000 items over a real loopback socket,
with 20 text deltas per second. No provider processes or subscription quota were used.
The shared Mac has 16 logical CPUs. During the scroll run, load averages were
26.26 / 126.31 / 119.49. These measurements describe that simulator and host load.
They do not establish physical-device behavior.

| Gate                                        | Result                        | Evidence and interpretation                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable 60/120 fps scrolling without hitches | Not passed                    | The 15-second typing window averaged 34.3 display-link callbacks/s; p95 callback gap was 69.2 ms. This includes startup and automation activity, and is not GPU presentation FPS. It cannot establish stable 60/120 fps.         |
| p95 input latency at most 100 ms            | Application-side proxy passes | 41.9 ms p95, 51.9 ms maximum, 92 text edits. Boundary is native text-edit acceptance callback to next display-link callback. Keyboard delivery before the callback and GPU presentation after it are excluded.                   |
| Bounded memory over time                    | Pass for this window          | 125.0 seconds, 25 samples. After 30 seconds, physical footprint ranged 161.0 to 176.4 MiB and ended at 173.6 MiB. Retained item count stayed 2,000. No steady upward trend in this window; longer/device runs remain unmeasured. |
| Offline send                                | Pass                          | SDK pending state follows committed SQLite persistence. Actual socket outage leaves a durable send pending.                                                                                                                      |
| Kill/relaunch replay                        | Pass                          | XCUITest terminates the app process after the pending send is persisted, restores connectivity, relaunches, then checks exactly one matching canonical daemon input.                                                             |
| Canonical whole-tree state                  | Pass                          | Root completion with a working child remains Working through the real SDK/socket bridge.                                                                                                                                         |

The scroll XCUITest completed three measured iterations, each with two downward and
one upward fast swipe. XCTest recorded memory but returned no scroll-deceleration
samples. Peak physical memory across those iterations was 187,271.7 to 195,742.3 kB.
An Animation Hitches trace attempt returned:

> Hitches is not supported on this platform.

A successful XCUITest run does not fill that measurement gap. Neither empty signpost
metrics nor display-link cadence counts as proof of hitch-free GPU rendering.
The low callback cadence and missing render evidence hold the gate. Do not infer
that the shared SDK or JavaScriptCore alone caused it; initialization, accessibility
automation, native rendering and host contention have not been separated.

The idle streaming portion after the first 30 seconds averaged 41.5 callbacks/s, with a 50.0 ms p95 gap. This is a different workload from scrolling and still supplies no GPU presentation evidence.

Raw evidence: [summary](../design/ios-spike/results.json), [input/cadence samples](../design/ios-spike/input-raw.json),
[XCTest scroll metrics](../design/ios-spike/scroll-xctest.json),
[memory samples](../design/ios-spike/memory-raw.json). Latency uses nearest-rank p95.
The input/cadence runs precede the final navigation-cancellation review fixes and
the shared typography/layout token follow-up. Navigation fixes receive separate
behavior verification; refreshed screenshots verify the token follow-up. No
performance improvement is claimed for either change; these numbers are not a new
measurement of the final visual revision.

## Screens and remaining scope

[Side-by-side comparison](../design/ios-spike/comparison.html) pairs native simulator
screenshots with the approved reference. The native Thread screenshot shows the
stress fixture's long streaming tail. The approval screen uses the smaller reference
scenario. Debug counters are measurement controls. These screens establish the
single-inbox navigation and inline card layout, not final MVP visual parity.

Phase 1 includes QR pairing, Keychain device tokens, pinned HTTP ticket exchange,
Face ID, multi-machine inbox grouping, questions, collapsed work/inline agents,
Agents and Changes sheets, and full native polish. The spike's debug-only endpoint
and limited portable polyfills are not a production pairing or encrypted-relay client.
The SPKI transport exists but has no real paired-daemon TLS evidence in this run.

Push and Live Activity remain Phase 2. Their ADR must specify delivery without
shipping APNs signing keys in the daemon. A hosted relay or paid Apple service needs
the maintainer's approval before implementation. This spike introduces neither.

## Gate disposition

Stop at Phase 0 and submit the work and measurements for review. Keep the requested
SwiftUI/JavaScriptCore implementation available for another measured run. Establish
render FPS/hitches on a supported device or instrumentation path and complete the
input boundary measurement before approving Phase 1. Any switch to Expo requires
the maintainer's explicit decision after reviewing the numbers.

## Primary references

- [Apple JavaScriptCore VM thread behavior](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine)
- [Apple URLSession WebSocket delegate](https://developer.apple.com/documentation/foundation/urlsessionwebsocketdelegate)
- [Apple Liquid Glass modifier](<https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)>)
- [XcodeGen project source/resource specification](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md)
