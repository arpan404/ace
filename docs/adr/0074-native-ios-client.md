# 0074: Native iOS client on the shared SDK through JavaScriptCore

Date: 2026-10-12. Status: Phase 0 evidence accepted; smoothness gate not passed. Phase 1 held.
Amends [ADR 0003](0003-runtime-and-tooling.md). Refs #560.

## Phase 0 outcome

The owner accepts this spike as Phase 0 evidence. Simulator and contract results
prove the SwiftUI/shared `@ace/client` JavaScriptCore bridge architecture, durable
local admission, approval recovery after persistence failure or daemon refusal,
and delivery fairness under oversized updates, rejection and continuous streaming.

Stable 60/120 fps on a real device remains unproven. Safe runtime replacement and
relaunch after daemon admission with a lost receipt now have the follow-up
functional verification below; they do not release the performance gate.

The rejection-versus-newer-update race was fixed in `8aae02b70` after round 4.
Its regressions pass, but the fix has not been re-reviewed. PR #567 remains draft
and unmerged, with `Refs #560` and the performance gate held. Phase 1 waits for the
owner's go-ahead and real-device measurements.

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
unchanged text. Display titles and metadata use 512-code-unit previews, approval
descriptions 2,048, commands 8,192 and option labels 128, with visible shortening.
Canonical state, identities and action IDs stay exact. Exceptional patches use
acknowledged base64 fragments containing at most 18 KiB UTF-8 rather than being
discarded. The SDK's 2 MiB physical wire-frame cap does not limit reconstructed
logical messages. Its default fragment admission budget is 64 MiB retained UTF-16.
That can encode up to 96 MiB UTF-8 before the bridge wraps identities and attaches
a scope from another reader. Native assembly admits one complete patch at a time
with a conservative 512 MiB UTF-8 allowance for those DTOs. It allocates only bytes
received, not the allowance up front. The SDK still owns logical wire admission.
Dirty keys stay queued until the final frame is accepted. Rejected frames send a
negative acknowledgment. Rejected rows retry individually with 32/128/512 ms
backoff, then use display placeholders retaining canonical state, identities and
actions. Accepted placeholders retain degraded mode until deletion or resnapshot;
continuous bad deltas cannot renew their raw retry budget. An undecodable canonical
identity remains retained with a visible error and no scheduled spin; a changed
reader or resnapshot can retry it. Scope resets precede their own rows, including
when a reset is delayed by rejection. Status, approvals and command outcomes have
priority over transcript content. Updates arriving during a transfer stay dirty
and rotate behind their pending peers when the older transfer is confirmed.
Previews use native Unicode grapheme boundaries and replace ill-formed display
text before JSON serialization. Opaque identities never pass through this adapter. The SDK's existing item truncation flag is preserved alongside bridge
truncation. Navigation generations reject stale patches, including reopening
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
the shared typography/layout token follow-up and round-1/round-2 bridge fixes.
These fixes receive separate behavior verification; refreshed screenshots verify
the final visual revision. No performance improvement is claimed for these changes;
the numbers above are not a new measurement of the final revision.

## Round-1 review fixes and verification

Local UI request IDs correlate admission and receipt results; the SDK allocates
protocol command IDs. `ClientCore.enqueue()` confirms durable local admission.
Composer text stays visible until that promise succeeds, remains on SDK limit or
SQLite write failure, and does not erase edits made while a save is in flight.
Daemon refusal remains represented by the SDK's retained failed send payload.
No native layer implements its own admission, replay or outbox state machine.

Approval submission state is keyed by interaction and request ID. Failed local
admission or a refused receipt restores controls for that attempt. Successful
admission displays Waiting for the daemon; only canonical interaction updates
close the card. Unrelated or older attempt results cannot release another card.

Fourteen Swift behavior/bridge tests pass on iOS 26.5. New real-edge contracts cover
Done → Working with oversized Unicode metadata, large approval details and an
exact 40,007-character action ID, SDK send-limit rejection, SQLite trigger-induced
rollback, successful durable retry, and approval recovery after persistence failure
and daemon refusal. Scoped formatter, lint, `@ace/ios` typecheck and theme
reproducibility also pass. Xcode builds remain serial with `-jobs 4`.
The three-screen capture and actual offline-send/termination/relaunch UI cases
also pass. The latter exposed a focus failure with the token-sized composer field;
the field now uses the shared 48-point minimum touch height and token insets, and
the replay case passes with native typing. This is functional verification, not a
new input-latency or rendering measurement.

Two gaps were deferred after round 1 (addressed by the follow-up below):

- A second `ClientModel.connect()` replaced a runtime without awaiting its
  shutdown or rejecting callbacks from the older connection. The spike app started
  one connection; reusable multi-machine connection lifecycle needed this fix.
- The original termination/relaunch test covered a persisted send before daemon
  admission. It did not force the separate failure window of daemon admission
  followed by a lost receipt, termination and replay, or verify one canonical input
  after that replay settled.

### Connection lifecycle and lost-receipt follow-up, 2026-10-13

`ClientModel.connect()` now awaits a serialized old-runtime shutdown before
creating another VM. A connection generation rejects retired callbacks, while
replacement clears host-specific native views and bridge-fragment assembly.
Overlapping replacements select the latest request; disconnect invalidates a
waiting replacement and cancels local admission waiters. A queued run-loop stop
also closes the startup race where a direct stop could precede `CFRunLoopRun()`.

Thirty Swift behavior/bridge tests pass with Xcode 26.3 on the iPhone 17 Pro
iOS 26.3 simulator. Four lifecycle cases include late updates/errors, overlapping
replacements, disconnect during replacement and immediate shutdown of real VMs.
The new UI contract passes through actual process termination and relaunch:
the fixture first admits a unique send, drops its receipt and disables connections;
the test verifies one canonical input before terminating, restores connectivity,
then verifies replay of that command and exactly one input after its receipt.

This closes the two functional gaps within the simulator/fixture scope. No physical
phones were available; rendering, input, paired TLS and daemon-restart durability
remain unproven. Phase 1 is still held. The cross-platform feature inventory and
Tailscale pairing plan are in the [mobile roadmap](../mobile/tailscale-roadmap.md).

## Round-2 transfer correction

The previous 8 MiB native assembly limit incorrectly treated physical wire frames
as the ceiling for logical SDK data. A failing native regression reproduced the
loss of an approval containing 300 distinct action IDs, each over 32 KiB. It failed
with "Could not read a client update" and no visible approval. That regression now
passes with all identities intact.

Real JavaScriptCore/socket contracts receive the same large approval through
`snapshot.part` reassembly in `@ace/client`, then resolve an exact offered action
and verify its canonical daemon resolution. A second contract rejects the final
native frame once, requires the approval to remain absent while the transfer is
unconfirmed, then verifies redelivery and exact resolution without resnapshotting.
This guards both the native acceptance result and retirement of dirty keys.

Seventeen Swift behavior/bridge tests pass. A simulator UI case opens the large
approval, selects an action through its native More choices menu, and observes
canonical closure. The card shows up to three direct controls; larger collections
retain every remaining action in the menu. Scoped formatter, lint, `@ace/ios`
typecheck and theme reproducibility pass. These are correctness checks, with no new
rendering, memory or input-latency gate claim. The performance gate remains held.

## Round-3 delivery correction

The deterministic JavaScriptCore/native-decoder regression initially failed on
`"😀" + "x".repeat(8191)`: tail slicing split the emoji, native decoding rejected
five attempts, and a later canonical Working row remained absent. The separate
100-KiB item-ID scenario continuously replaced the content reader and left a queued
approval absent after 16 delivery cycles. A permanently invalid display field also
blocked later Working status. All three initial regressions failed in 0.113 seconds
of test execution; no daemon or wall-clock waits are needed for this feedback loop.

Native grapheme previews now preserve surrogate pairs, combining marks and joined
emoji. Bounded previews explicitly repair unpaired UTF-16 received through foreign
`NSString` values, even when no truncation is needed. The actual TypeScript presenter and pump deliver the boundary title and
later Working status without rejection. With the 100-KiB ID duplicated in its DTO
and continuous reader replacement on every cycle, a queued approval with an exact
32-KiB action ID, Working status and a same-priority sibling content row all arrive
within 16 cycles. After streaming stops, the latest retained revision also arrives.
These are virtual delivery-cycle bounds, not display FPS or device input latency.

Permanent display rejection produces a visible placeholder after at most three raw
attempts. Backoff leaves other work eligible; rejection of a batch isolates its
rows on retry. Replacement readers preserve the retry budget, even after the first
placeholder is accepted. The tests verify exact action IDs/kinds and pending state,
no scheduled retry spin, recovery after an undecodable identity changes, and that a
delayed reset cannot erase rows acknowledged ahead of it. Test-only JavaScript is
bundled into the unit-test target; the shipping app has no scenario hooks.

Twenty-four Swift behavior/bridge tests pass on the single iOS 26.5 simulator,
including the real SDK/socket and SQLite contracts from previous rounds
(37.616 seconds of test execution). [Captured verification](../design/ios-spike/round3-delivery-tests.txt)
records baseline failures and the final results. Scoped
formatter, lint, `@ace/ios` typecheck and theme reproducibility pass. The performance
gate stays held; no new rendering, memory or input-latency measurement is claimed.

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
