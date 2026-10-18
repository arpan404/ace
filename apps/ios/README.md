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

## Inbox

`bridge/inbox.ts` sends each thread row with its status word and colour token, and
the inbox sections (Needs you, Working, Syncing, Unsent, Done, Snoozed) in order. Both
come from `@ace/ui-core/mobile`, which Android also uses. Swift filters by search text,
maps token keys to theme colours and draws the rows. Archive, unarchive (Undo), snooze
presets and wake go through the SDK's durable outbox. Rows carry a machine id so a
later multi-machine inbox can merge daemons. `InboxContractTests` and
`InboxUITests` exercise the inbox against the fixture.

## Agents and Changes sheets

The thread header opens two detent sheets (`Views/Agents`, `Views/Changes`). The bridge
follows each only while its sheet is shown (`bridge/sheets.ts`), and navigation releases both.

- Agents: `agentSheet` in `@ace/ui-core/mobile` shapes the tree depth-first with each
  agent's tree-aware status (`agentTreeWork`), so a finished root with a working child never
  reads done. It also carries usage, the root's context meter and background tasks. Trees cap
  at 100 agents and 30 tasks. Unsettled agents and their ancestors win the cap, and every
  hidden agent and task is counted. Only entity changes reshape the tree; transcript deltas
  don't. Stop all, and stopping an agent with subagents, ask first. Stops go through the
  durable outbox (`thread.interrupt`, cascading), as does `background_task.stop`.
- Changes: the bridge reads `git.status` (≤500 files), `git.diff` (≤256 KiB) and, for a
  linked PR, `pr.status`. It keeps these reads only while the sheet is open. It sends at most
  200 file rows and one file's diff at a time, within 1,500 lines, 1,000 UTF-16 units per
  line and 96,000 in total. Past that, the view points to the computer. The next step
  (commit & push, push, create PR, merge) follows the web's `nextGitStep` and `mergeGate`. It
  runs through the daemon's guarded git and forge commands. A view-only grant
  (`ClientModel.canOperate`) shows both sheets without their actions.

`scripts/sheet-scenario.ts` seeds the fixture's `ios-tree` thread with a nested subagent
tree, a running background command, usage, and a three-file diff. The diff includes a
3,000-line file and a long line. Set `ACE_IOS_SPIKE_PORT` and launch with
`--spike-port N` to run a fixture beside another agent's.

## Pairing with a real daemon

Without `--spike` the app pairs with a real daemon. Scan the QR from `ace pair` (or
Settings > Remote devices), or paste its link. The confirm screen shows the address,
grant and fingerprint, and asks for this phone's name. Only scheme, host and port
leave the link; the code goes in the `/v1/pair` POST body.

- `Sources/Host/PinnedHTTP.swift` and `PinnedSocket.swift` share `PinnedTrust`. It
  checks the exact SHA-256 DER SPKI pin and the certificate's validity window, with
  no CA or hostname fallback. Redirects and 3xx responses are refused. Requests are
  limited to fixed `/v1/` paths with a 1 MiB response cap.
- The bridge (`bridge/access.ts`, `pairing.ts`, `access-entry.ts`) uses the SDK's
  `ticketCredential`, `accessResponseError`, protocol schemas and `MachineDirectory`.
  Every socket attempt exchanges the Keychain token for a fresh `/v1/tickets` ticket.
  A short-lived pinned connection reads `host.identity` before the machine is stored.
- Device tokens live only in the Keychain (`AfterFirstUnlockThisDeviceOnly`).
  A connection runtime may read only its own key. `machines.json` holds non-secret
  directory metadata; each outbox database is named by host and device identity.
- Switching machines awaits the old runtime's shutdown, and the old runtime's
  callbacks are discarded. Removing a machine deletes its credential, then its database.
- Face ID or the passcode unlocks the app at launch, and again after 60 seconds in the
  background. Nothing is read or connected before unlock.
- The machine bar shows the SDK's connection problem: unreachable (still retrying),
  offline, revoked, pin mismatch, or another host. It also marks view-only grants.
  `NWPathMonitor` reports network changes to the SDK, which owns reconnect.

`bun run e2e:pairing` starts a real daemon with its LAN TLS listener advertised on
loopback, plus a redirect trap that holds the daemon's own key. It writes
`/tmp/ace-ios-pairing-e2e/config.json`. With the script running, run
`-only-testing:AceTests/RealDaemonPairingTests` with `test-without-building`; codes
expire in five minutes. These tests skip when the config is absent.

## Scope

`--spike` (Debug only) keeps the unpinned loopback fixture. Release builds require WSS
and an exact pin. A real device over Tailscale, the full multi-machine inbox,
and questions are still to come.

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
