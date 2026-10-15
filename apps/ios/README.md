# Native iOS spike

Phase 0 of #560. SwiftUI runs the shared `@ace/client` SDK in JavaScriptCore on a
dedicated thread. See [ADR 0074](../../docs/adr/0074-native-ios-client.md) for the
measured gate and current hold on Phase 1.

The [Tailscale roadmap](../../docs/mobile/tailscale-roadmap.md) maps shared features
and the future native pairing flow for iOS and Android.

## Run

From this directory, with dependencies installed at the repository root:

```sh
bun run generate
bun run spike:daemon
```

In a second terminal:

```sh
xcodebuild -project Ace.xcodeproj -scheme Ace -configuration Debug \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UDID' \
  -derivedDataPath .build/DerivedData -jobs 4 build
xcrun simctl install YOUR_SIMULATOR_UDID .build/DerivedData/Build/Products/Debug-iphonesimulator/Ace.app
xcrun simctl launch YOUR_SIMULATOR_UDID app.ace.ios --spike
```

Use one simulator destination and one build at a time. The fixture binds to
loopback port 9841, invokes no provider CLIs and spends no provider quota. It seeds
2,000 items, streams 20 deltas per second, opens a shell approval and keeps a child
working after its root finishes. Restart the fixture before independent screenshot
or performance runs. Contract sends deliberately add inputs to its history.

XcodeGen output, generated `Resources/client.js`, build products and xcresult bundles
are ignored. Run `generate` before opening Xcode. The Swift theme is committed;
`theme:check` validates reproducibility against the schema-validated token JSON.
SF Pro and SF Mono with Dynamic Type follow the issue's native typography decision.
The shared tokens supply colour, type size/weight/tracking/line height, spacing,
radii, dimensions, elevation, opacity and motion timing. Native system chrome keeps
its platform defaults. Status-coloured text uses `statusText`; state dots and icons
use `status`. The generated theme contains the UIKit and SwiftUI type adapters;
custom views carry no separate palette or numeric style overrides. Spring motion
uses the shared enter duration and respects Reduce Motion.

## Verification

With the fixture running, use the same destination and `-jobs 4`, adding
`-parallel-testing-enabled NO`. Select `-only-testing:AceTests` for the thirty Swift
behavior/bridge tests, or individual `AceUITests/SpikeUITests` methods for screenshots,
scrolling, typing, actual offline termination/relaunch, and the two-minute memory run.
Keep a fresh fixture for screenshot/scroll/memory runs; restart verification accepts
its own added inputs. Never run the root test suite, root typecheck or combined check
on this shared Mac for this issue.

The debug app writes `Library/Application Support/ace/spike-metrics.json` every five
seconds. `xcrun simctl get_app_container YOUR_SIMULATOR_UDID app.ace.ios data` locates
it. It contains physical footprint/RSS, item count, bridge frame size, text-edit
callback to next display-link callback latency and display-link callback gaps.
Callback cadence does not establish GPU presentation FPS. Save metrics before the
next app launch, which starts a new window. XCTest attachment exports preserve the
simulator screenshots.

## Ownership and bounds

- `bridge/` imports only package public exports. `ClientCore` owns protocol decoding,
  reconnect, snapshot/replay, history admission and the durable outbox. Its pending-send
  states and canonical daemon statuses drive the native UI.
- `Sources/Bridge/` owns a VM and run loop. Swift callbacks return to that thread;
  SwiftUI receives decoded, owned data. A single acknowledged frame carries at most
  32 patches and 32 KiB. Pending changes retain keys and readers, not transcript copies.
  Oversized updates use acknowledged base64 fragments carrying up to 18 KiB UTF-8.
  Native assembly holds one patch, with a 512 MiB UTF-8 allowance covering the SDK's
  64 MiB UTF-16 reassembly budget and DTO identity duplication. The 2 MiB socket
  cap is a physical frame limit. Dirty keys retire only after confirmed delivery;
  rejected rows retry individually with backoff, then degrade display details while
  preserving canonical identities, status and actions. Changed readers rotate
  behind peers after delivery; status, approvals and command outcomes precede
  content. Native previews preserve grapheme boundaries. Degraded mode lasts until
  deletion or resnapshot. Undecodable identities stay retained without a retry spin,
  report a visible error, and can retry on a changed reader or resnapshot.
- `Sources/Host/` owns URLSession sockets and transactional SQLite. Durable record writes
  use WAL with FULL synchronous commits before resolving JS promises. The database path
  includes daemon/device identity; its immutable host binding rejects another daemon.
- Native item models preserve identity across deltas. Membership and position updates
  change the order separately. The SDK bounds the spike window to 2,200 items and text
  to 8,192 code units. Snapshots remain capped at 200; the spike calls the SDK's history
  paging API to admit the rest.
- Composer drafts clear after `ClientCore.enqueue()` confirms local persistence.
  Failure preserves the input. Approval controls recover through correlated
  admission/receipt results; canonical interaction updates close the card.
- Large-approval contracts use 300 distinct action IDs over 32 KiB, real SDK
  snapshot fragments and exact canonical resolution, including redelivery after
  final-frame rejection. Deterministic JavaScriptCore/native-decoder tests also
  cover surrogate boundaries, permanent rejection, continuous 100-KiB IDs alongside
  approvals/status/content, and delayed resets. `generate` bundles their scenarios
  only into the unit-test target. More than three offered actions use a native overflow menu.
- Encoding and secure entropy adapters provide the portable core's required globals.
  This is a direct TLS spike, not a browser runtime or a full Web Crypto implementation.
  Additional URL/crypto APIs for future service and encrypted-relay flows need contracts
  before those flows ship.

## Scope

The app currently connects through an explicit debug launch argument. Release builds
cannot use the unpinned loopback fixture. Production targets require WSS and an exact
QR-confirmed SHA-256 DER SPKI pin; redirects are refused. Actual paired TLS, ticket
exchange, QR onboarding, Keychain, Face ID, multi-machine UI, questions, Agents and
Changes remain Phase 1 work. SPKI adapter implementation is present; it has not been
validated against a real paired daemon in this spike.

Connection replacement now awaits old-runtime shutdown, clears host-specific views
and rejects its late updates/errors. Concurrent replacements select the newest
request, and disconnect cancels a waiting replacement. Run-loop shutdown is queued
so a stop during VM startup cannot be lost. Four lifecycle contracts cover these
cases, including immediate destruction of real JavaScriptCore runtimes.

`testAdmittedSendWithLostReceiptSurvivesTerminationAndReplaysOnce` arms a fixture
failure for a unique send. The daemon admits it, drops its first receipt and goes
offline. The UI contract verifies admission before process termination, relaunches
the app, verifies replay of the same command and checks exactly one canonical input.
The thirty Swift tests and this UI test pass with Xcode 26.3 on the iPhone 17 Pro
iOS 26.3 simulator. These checks do not establish real-device performance, remote
pairing or daemon-restart durability.

APNs and Live Activity remain Phase 2. No hosted relay, paid Apple service or APNs
signing credentials are implemented here. The proposed delivery design and approval
must precede that work.
