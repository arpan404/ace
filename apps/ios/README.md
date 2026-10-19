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
or performance runs. Contract sends deliberately add inputs to its history. The
streaming thread's turn never ends, so a queued follow-up waits in the daemon queue,
outside the transcript, as it would on a real daemon; `GET /queue?thread=ID` lists it.

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

## Thread screen

`bridge/thread-session.ts` adds, per navigation generation, what the thread screen needs
beyond item and interaction rows. Transcript blocks come from the web's shared grouping
(`@ace/ui-core/transcript-blocks`): "Worked for" heads with the shared work counts,
subagent groups rolled up by whole branch, questions and turn endings. Blocks re-derive on
membership, run, agent, task or interaction changes, never on a text delta, and each
changed block is one patch at content priority. Composer controls carry the shared
steer/queue rule (`followUpDelivery`) and Stop's run fence (`stopFence`); actions send intent
only, and the bridge builds `thread.send`, `thread.interrupt`, `interaction.resolve`,
`thread.switch` and failed-send retry (`retrySend`) from the SDK reader. Approval rows name
the shared Allow once / Always allow / Deny verbs by option index, so large option sets are
sent once with exact canonical ids.

SwiftUI renders blocks with native Markdown (`Models/Markdown.swift`, SF Mono code blocks),
collapsible work logs, inline subagent rows (a delegated child thread pushes; a native
subagent's lane opens a sheet), question and approval cards above the composer, a model
sheet and the header menu (Stop all agents, Snooze, Archive). The fixture's thread scenarios
live in `scripts/thread-scenarios.ts`. `ACE_IOS_SPIKE_PORT` moves the fixture, and the app's
`--spike-port N` argument and `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for tests follow it. TS bridge
behavior tests run with `bunx vitest run apps/ios/bridge/thread-*.test.ts` (shared harness in
`bridge/thread-harness.ts`).

Plan reviews, MCP forms and browser requests answer on their own cards
(`bridge/thread-requests.ts`, validated with the shared `@ace/ui-core` form rules). An opened
settled "Worked for" log reads its turn's full steps (`turn.steps` through the SDK's bounded
`TurnStepsCache`), sent in 25-step page patches. The effort and speed chip follows the web's
capability rules (`threadTuning`, `followUpTurnOptions` in `@ace/ui-core`); a pick goes with the next
message only. Photos and files are staged natively (`Sources/Bridge/AttachmentStaging.swift`,
hashed with CryptoKit); the bridge checks the shared limits and what the agent reads, then uploads
through `context.request`, pulling one 48 KiB chunk at a time over the `attachment.chunk` host call.
A native subagent's lane sheet groups its own blocks (`createBlockReader(agentId)`). Going back from
a child keeps the parent's last transcript (`ThreadTrail`) until the reopened session's first block.
Request threads live in `scripts/request-scenarios.ts`; `POST /review/fresh {"scenario": …}` seeds a
new one per contract test, so suites pass in any order.

## Scope

The app currently connects through an explicit debug launch argument. Release builds
cannot use the unpinned loopback fixture. Production targets require WSS and an exact
QR-confirmed SHA-256 DER SPKI pin; redirects are refused. Actual paired TLS, ticket
exchange, QR onboarding, Keychain, Face ID, multi-machine UI, Agents and Changes
remain Phase 1 work. SPKI adapter implementation is present; it has not been
validated against a real paired daemon in this spike.

## Inbox

`bridge/inbox.ts` sends each thread row with its status word and colour token, and
the inbox sections (Needs you, Working, Syncing, Unsent, Done, Snoozed) in order. Both
come from `@ace/ui-core/mobile`, which Android also uses. Swift filters by search text,
maps token keys to theme colours and draws the rows. Archive, unarchive (Undo), snooze
presets and wake go through the SDK's durable outbox. `InboxContractTests` and
`InboxUITests` exercise the inbox against the fixture.

## Several machines

Every paired machine connects at once, each on its own runtime (VM, socket, outbox
database, Keychain key), as the web's `MachinePool` gives each machine its own worker.
Each runtime groups its own threads with `@ace/ui-core/mobile`, which also gives every
row a rank (`inboxRank`) that depends only on that row. `MergedInbox` orders sections by
group and rows by rank in UTF-16 order, so the merged inbox matches grouping every
machine together; the TS tests in `mobile-inbox-merge.test.ts` hold it to that.
`MachineInbox` keys rows by machine and thread id, routes actions and opened threads to
the row's machine, and names machines on rows only when more than one is paired. A
machine that drops gets its own banner and keeps the rows this phone last saw (a copy
restored from disk and not yet confirmed reads Syncing); the other machines are untouched. Each machine's runtime adds about 48 MiB in the simulator (see the PR).

The header chip opens the Machines sheet: connection word and last seen
(`bridge/machine-info.ts`, `machineConnection`), access, address, ace version, and the
coding tools the machine reports (`providers.request` readiness and `accounts.list`,
worded by `machineProviders`). Rename is local to this phone (`MachineDirectory.rename`);
remove stops only that machine's runtime, then deletes its credential and database.

`--spike-machines 9852,9863` connects one fixture runtime per port; start each fixture
with `ACE_IOS_SPIKE_PORT=<port> ACE_IOS_SPIKE_MACHINE=1 bun run spike:daemon` so each is
its own host. `MachinesUITests` uses those two ports.

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

## New thread, projects and files

The inbox header's compose button opens New thread (`Views/NewThread`). It follows the web's
New thread: machine (when several are paired), project, an optional new worktree with its base
(`baseOptions`, `defaultWorktreeBase`), coding agent and model, then the first message. The
bridge (`bridge/new-thread.ts`) reads projects (`workspaces.list`, recent first by thread
activity via `newThreadProjects`), the machine's agents (`providers.request` readiness,
`accounts.list` and the paged `models.list` reader shared with the web), and judges each with
`newThreadAgents`: one that isn't installed, is signed out or needs attention stays listed,
disabled, with its reason. It builds `thread.create` with the web's `createPayload` and admits
it through the SDK outbox under the draft's own command id, so sending the same draft again,
including after the app was killed, replays one command. The draft (choices and words, never a
token) lives in `Application Support/ace/new-thread-draft.json`. Once the receipt names the
thread and its row arrives, it opens; offline, it waits in Unsent.

`@` mentions insert `@path`, as the web's composer does. Before a thread exists they search a
device-owned draft scope (`draft.create`, `draft.mention.complete`). Add project searches the
computer's folders (`fs.recentFolders`, `fs.search`) and registers one with `workspace.add`; a
computer that refuses this phone's project requests gets "add it on your computer" instead.

A thread's menu opens Files (`bridge/project-files.ts`, `Views/Files`): the daemon's listing of
the thread's checkout (at most 1,000 paths) shown one folder at a time, 200 rows each with the
rest counted, search through `mention.complete`, and a read-only SF Mono preview of at most
128 KiB, 2,000 lines and 96,000 UTF-16 units, past which it says to view the rest on the
computer. The protocol only lists files inside a thread's checkout, so New thread offers file
search, not browsing. View-only machines browse but start nothing. `scripts/project-scenario.ts`
seeds host folders, a 240-file folder and a large log in `ios-done`.

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
- Removing a machine awaits its runtime's shutdown and discards its callbacks, then
  deletes its credential, then its database. Other machines keep running.
- Face ID or the passcode unlocks the app at launch, and again after 60 seconds in the
  background. Nothing is read or connected before unlock.
- Each machine's banner and Machines sheet entry show the SDK's connection problem:
  unreachable (still retrying), offline, revoked, pin mismatch, or another host. The
  sheet also marks view-only grants.
- Local notifications bind to every paired machine's runtime before it connects, each with
  its own catch-up ledger. Alerts carry their machine, so a tap opens the thread there and
  Allow/Deny answers that machine. A background refresh connects every paired machine (its
  grant, Keychain token and outbox) only to catch up on daemon alerts, all within one time
  budget; it shows no UI, so the app lock still guards the app itself. A view-only pairing
  never answers Allow/Deny from a notification.
- A view-only grant replaces the composer with a note, leaves approval choices disabled
  and drops archive and snooze for that machine's rows. `ClientModel` submits no commands
  for that machine; the others are unaffected.
  `NWPathMonitor` reports network changes to the SDK, which owns reconnect.

`bun run e2e:pairing` starts a real daemon with its LAN TLS listener advertised on
loopback, plus a redirect trap that holds the daemon's own key. It writes
`/tmp/ace-ios-pairing-e2e/config.json`. With the script running, run
`-only-testing:AceTests/RealDaemonPairingTests` with `test-without-building`; codes
expire in five minutes. These tests skip when the config is absent.

## Scope

`--spike` (Debug only) keeps the unpinned loopback fixture. Release builds require WSS
and an exact pin. A real device over Tailscale and questions are still to come.

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

## Notifications

Local only ([ADR 0087](../../docs/adr/0087-ios-local-notifications.md)). `Sources/Notifications/`
posts the daemon's canonical `notification` messages and its `notification.feed` catch-up with
`UNUserNotificationCenter`; `bridge/notifications.ts` registers the phone, reports foreground or
background presence and runs approval actions through the SDK outbox. With the fixture running,
`curl -X POST localhost:9841/review/notify -d '{"threadId":"ios-approval"}'` sends an alert and
`/review/retract -d '{"id":"…"}'` withdraws one. Remote push (APNs, a push gateway) and Live
Activities are deferred; see the [draft](../../docs/adr/drafts/ios-push-notifications.md).

## Archive, settings and appearance

- **Snooze end while offline.** `inboxStatus(thread, now)` and `inboxNextChange` in
  `@ace/ui-core/mobile` decide it: a done thread whose snooze has passed reads "Snooze ended" in
  Done, and `bridge/inbox.ts` arms one timer (injected clock) for the soonest snooze end, so the
  phone regroups even when the machine that would wake the thread is offline. The fixture's
  `ios-nap` is snoozed for `ACE_IOS_SPIKE_NAP_MS` (default 90 s); `POST /control {"online":false}`
  before it ends to see it.
- **Archive** (inbox footer, or Settings): `bridge/archive.ts` switches that machine's SDK sidebar
  to its archive window and sends the shared `archivedOrder`, 20 per page. One machine's archive is
  followed at a time; closing returns to the home window. An archived thread opens read-only with
  an Unarchive note. The fixture seeds 45 archived threads.
- **Settings** (gear in the inbox header): app lock on/off (turning it off asks for Face ID or the
  passcode) and timeout, both remembered; notifications with a per-machine on/off and that
  machine's own quiet hours and snoozes; Machines and Archived links; version, licences (ace,
  Apache-2.0; Zod, MIT; no fonts or icon sets are bundled); a diagnostics export
  (`DiagnosticsReport`) holding codes and counts only, no tokens, device ids, addresses or pins.
- **App icon and launch screen**: `bun scripts/generate-icon.ts` draws the desktop's ace mark
  (`apps/desktop/build/icon.svg`) into a light, dark and tinted 1024 icon and writes the
  `LaunchBackground` colour from the `background` token.
- **Accessibility**: `PolishUITests.testEveryScreenPassesTheAccessibilityAudit` audits the inbox,
  New thread, projects, plan and form cards, steps, thread, Agents, Changes, Files, Machines,
  Settings and Archive. `testSubScreensPassTheAccessibilityAudit` audits an agent's transcript, a
  diff, the commit editor, a machine's detail, notification settings per machine and the licences.
  Missing descriptions and small hit areas fail them; every other finding is attached as a report.
  Set `TEST_RUNNER_ACE_IOS_TEXT_SIZE` to a content size category to run them at another text size,
  and `xcrun simctl ui <udid> appearance dark` for dark mode. Both pass at the default size and at
  `UICTContentSizeCategoryAccessibilityXXXL`. At accessibility sizes they scroll to each target and
  also audit the rows below the fold, Agents' background tasks and the Changes next step.
  At accessibility sizes, half-height sheets open full height, and the Changes next step ends the
  file list instead of floating over it. Rows whose trailing values would squeeze their labels
  (file counts, provider status and usage, a task's Stop, a machine's Retry) stack them underneath.
