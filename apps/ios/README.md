# Native iOS app

Issue #560. SwiftUI runs the shared `@ace/client` SDK in JavaScriptCore on a dedicated
thread, one runtime per paired machine. The Phase 0 spike merged on 2026-10-12 and Phase 1
is built on `ace/ios-mvp`; see [ADR 0074](../../docs/adr/0074-native-ios-client.md). Physical iPhone connection and UI checks now run against a paired daemon over Tailscale;
real-device GPU/frame-rate measurement is still owed. See the
[phone verification record](../../docs/verification/ios-phone-parity/README.md).

The [Tailscale roadmap](../../docs/mobile/tailscale-roadmap.md) maps shared features
and native pairing flows for iOS and Android.

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
its own added inputs. Use the package typecheck for focused bridge changes. The root
`bun run check` remains the repository completion gate required by `AGENTS.md`.

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
  Unsent words are kept per machine and thread in `thread-drafts.json` (`ThreadDrafts`, the
  web's limits: 50 drafts, 100,000 characters), saved once typing pauses and at once when the
  composer empties, so leaving a thread or a relaunch gives them back and a sent message never
  returns. `--spike` launches start without them unless `--spike-keep-state` is passed.
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

A work log reaches Swift as the web draws it (`bridge/work-log.ts`, over the shared
`@ace/ui-core/work-log-reading`): sentence groups with their icon and failures, the live group
titled by its step in flight, thoughts with their time, background commands as one group, ace's
audits folded away. Each step's own line (glyph, verb, target, stat, note, bounded detail from
`bridge/step-detail.ts`) travels on its item row, so streaming touches that row alone. Turn
endings and changed-file chips come from `bridge/turn-ending.ts`.

Message rows follow the web's (`bridge/thread-messages.ts`): item rows carry the person's
bubble (`bubbleContent`: word, code and mention runs, the long fold, Steer or Queued) and a
thought's header (`thoughtLabel`); event blocks carry the web's own event decision
(`eventView`: system rows, errors with ×N and Details, refusals, Not sent, notices, the handoff
divider), re-read when the order around them changes; answer blocks say whether they still
stream. A truncated finished answer reads its whole text in place (`native.message`).

SwiftUI renders blocks with native Markdown (`Models/Markdown.swift`, SF Mono code blocks),
work logs on a step rail, inline subagent rows worded as the web's (`@ace/ui-core`
subagent-row: meta, live detail, elapsed; a delegated child thread pushes, a native
subagent's lane opens a sheet), question and approval cards on the strip above the composer
(words typed while a question waits answer it through the shared `composerReply`), a model
sheet and a quiet header: back, title and the ⋯ menu (Agent tree, Stop all agents, Snooze,
Archive). Rows keep the web's 8/16/24 rhythm (`@ace/ui-core` row-room). The fixture's thread scenarios
live in `scripts/thread-scenarios.ts`. `ACE_IOS_SPIKE_PORT` moves the fixture, and the app's
`--spike-port N` argument and `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for tests follow it. TS bridge
behavior tests run with `bunx vitest run apps/ios/bridge/thread-*.test.ts` (shared harness in
`bridge/thread-harness.ts`).

Plan reviews, MCP forms and browser requests answer on their own cards
(`bridge/thread-requests.ts`, validated with the shared `@ace/ui-core` form rules). An opened
settled "Worked for" log reads its turn's full steps (`turn.steps` through the SDK's bounded
`TurnStepsCache`), sent in 25-step page patches, its groups in the steps header. While the log is open, a change to one of the
turn's own items reads the turn's summary (`turns.page`) and holds the turn with its `endSeq`, so
the cache reads it again only when its copy is older, as the web does. The effort and speed chip follows the web's
capability rules (`threadTuning`, `followUpTurnOptions` in `@ace/ui-core`); a pick goes with the next
message only. Photos and files are staged natively (`Sources/Bridge/AttachmentStaging.swift`,
hashed with CryptoKit); the bridge checks the shared limits and what the agent reads, then uploads
through `context.request`, pulling one 48 KiB chunk at a time over the `attachment.chunk` host call.
A message may carry only files (`messageHasContent`, as the web composer allows); refusals use the
web's wording (`contextErrorMessage`). New thread's picked files are copied into its draft's own
folder and named in the draft (never a token), so a relaunch puts them back on the message; the
copies go once the start is saved, or when a file is removed or another project is chosen.
Thread actions carry their navigation generation (`bridge/thread-route.ts`): a log or lane released
after its thread was left is dropped, and a submitted action is refused on its own admission.
A native subagent's lane sheet groups its own blocks (`createBlockReader(agentId)`). Going back from
a child keeps the parent's last transcript (`ThreadTrail`) until the reopened session's first block.
Request threads live in `scripts/request-scenarios.ts`; `POST /review/fresh {"scenario": …}` seeds a
new one per contract test, so suites pass in any order.

## Scope

`--spike` (Debug only) connects to the unpinned loopback fixture; release builds require WSS
and an exact QR-confirmed SHA-256 DER SPKI pin, and refuse redirects. Pairing, Keychain, Face
ID, several machines, Agents, Changes, Files, New thread and notifications are described
below. A physical phone over Tailscale and real-device performance are still unverified.

## Inbox

`bridge/inbox.ts` sends each thread row with its status word and colour token, and
the inbox sections (Needs you, Working, Syncing, Unsent, Done, Snoozed) in order. Both
come from `@ace/ui-core/mobile`, which Android also uses. Swift filters by search text,
maps token keys to theme colours and draws the rows. Archive, unarchive (Undo), snooze
presets and wake go through the SDK's durable outbox. `InboxContractTests` and
`InboxUITests` exercise the inbox against the fixture.

## Pull requests and Issues

The second tab (Pulls) holds the web's Pull requests and Issues pages for one machine and
project at a time: a segmented switch between them, the project and Filters chips (state with
GitHub's counts, involvement, sort, drafts, review, checks, author, labels), and the system
search field. `bridge/forge-service.ts` answers native service calls (`forge.pulls`,
`forge.issues`, `forge.pull`, `forge.issue`, `forge.merge`, `forge.auto-merge`,
`forge.projects`) through the daemon's forge reads, the person's own `gh`. Searches, groups,
next steps, merge gates, the primary control and the marks' words and tones come from
`@ace/ui-core` (`forge-lists`, `pr-readiness`, `pr-row-steps`, `pr-gates`,
`pr-primary-action`, `forge-marks`), the same modules the web pages use. List pages are kept
half a minute; pull to refresh reads again. Merge and auto-merge go through the PR's linked
thread when there is one, else its project (`forge.hosted.*`), pinned to the head shown and
confirmed first. Start thread on an issue opens New thread with the issue written in and
linked (`thread.create`'s `issue`). Linked threads open on the Threads tab. Bridge behaviour is
covered by `bridge/forge-service.test.ts` on the fake daemon.

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

## Live browser

Issue #1061, on the remote view protocol of [ADR 0088](../../docs/adr/0088-remote-browser-view-v2.md).
A thread's menu shows Browser while its browser has a tab open (`browser.tabs.list`, asked when the
thread opens and again as its state changes), and a browser request's card has Open browser. Both
open `Views/Browser/BrowserLiveView` full screen; the request's Done is offered there too.

- `bridge/browser-live.ts` subscribes (`browser.subscribe` with `binaryFrames`, the view's size and
  scale, and `video: avc1.42E033`), lays the page out at the view's size as a touch screen
  (`resize` with `touch` and the screen's scale), subscribes again after a tab, backend or
  connection change, and sends the shown tab's `browser.page` state and the person's input.
  The transport now reports binary support.
- Pictures never enter JavaScriptCore. `PinnedSocket` routes `ACES` stream pieces to
  `Sources/Browser`: `StreamAssembler` and `BrowserVideoChunk` read kind 2 (H.264); the live view
  is video only, so JPEG frames (kind 1), downloads (kind 8) and unknown kinds are skipped unread;
  any other binary message goes to the SDK. `BrowserRenderer` decodes on its own queue
  (VideoToolbox through `H264Decoder` from the keyframe's `avcC`) and acknowledges each chunk as
  soon as it is decoded, straight to the runtime (`browser.ack` with `video`, cumulative); a delta
  before a keyframe is acknowledged at once, a decode error asks for a keyframe
  (`VideoChunkGate`), and acknowledgements wait while the app is in the background
  (`BrowserAcks`). The surface's display link draws only the newest decoded picture on an
  `AVSampleBufferDisplayLayer`, at up to 60 frames a second; until the first keyframe a fresh view
  shows a loading state, and a restarted one keeps its last picture.
- Fingers go to the page as touch points (`TouchTracker`), so tap, drag-scroll and pinch are the
  page's own. A hidden `UITextField` over the focused field brings up the keyboard the field asks
  for (`KeyboardStyle`); `RemoteTyping` replays its edits as Backspace, Delete and text, and IME
  composition as marked text. Select, date, time, month, week and colour pickers open native
  pickers and answer with `pick` (`PickerValues`, in UTC). Tooltips show over the page.
- Tests: `BrowserStreamTests` (pieces written by the daemon's encoder), `BrowserInputTests`,
  `H264DecodeTests` (real VideoToolbox frames), `BrowserLiveTests`, and
  `bunx vitest run apps/ios/bridge/browser-live.test.ts` on the fake daemon.
- Device pictures (kind 4, ADR 0064 "Shared media stream") are read too, ahead of a device view:
  `Sources/Devices/DeviceFrameChunk` decodes the header, `AnnexB` pulls the parameter sets out of
  a keyframe and length-prefixes the rest for `H264Decoder(annexBKeyframe:)`, and
  `DeviceViewport` turns the picture upright, fits it, and maps a finger back to device points.
  `BinaryRouter` returns them as `.device`; `PinnedSocket` drops them until a view reads the
  devices channel. Tests: `DeviceStreamTests` (daemon-encoded pieces), `DeviceH264Tests`,
  `DeviceViewportTests`.

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
(`baseOptions`, `defaultWorktreeBase`), coding agent and model, reasoning effort, speed, access,
then the first message with any photos or files. The bridge (`bridge/new-thread.ts`) reads
projects (`workspaces.list`, recent first by thread activity via `newThreadProjects`), the
machine's agents (`providers.request` readiness, `accounts.list` and the paged `models.list`
reader shared with the web), and judges each with `newThreadAgents`: one that isn't installed,
is signed out or needs attention stays listed, disabled, with its reason. The agent picker groups
models by agent and leads with the model in use (else the account's default); the rest of a long
list waits behind More models (`newThreadModelList`). Swift tells the bridge what the draft has
chosen (`choice`), so ordering and access follow it.

- **Speed** offers the tiers the model lists and goes out as `serviceTier`
  (`selectNewThreadAgent`). **Access** (`bridge/new-thread-access.ts`) reads the daemon's
  default (`access.defaultMode`) and the chosen account's modes (`permissions.capabilities`),
  and applies the web's rule, now shared as `newThreadAccess`: the draft's pick, else the
  project's default, else the daemon's, run as the nearest stricter mode the agent supports. A
  mode with nothing as strict holds Start with the reason.
- **First-message files** upload into the project's draft scope (`draft.upload.begin`) through
  the same `AttachmentTray` as a thread's composer, one 48 KiB chunk at a time. The create
  carries their `draftId` and hashes, and the new thread takes the scope over, so closing the
  sheet afterwards releases nothing. A first message of only files can start a thread; one with
  neither words nor files is refused. Files picked before the app is killed are not kept.
- Upload and attachment refusals use the web's wording (`contextErrorMessage` in `@ace/ui-core`).

The bridge builds `thread.create` with the web's `createPayload` and admits it through the SDK
outbox under the draft's own command id, so sending the same draft again, including after the
app was killed, replays one command. The draft (choices and words, never a token) lives in
`Application Support/ace/new-thread-draft.json`. Once the receipt names the thread and its row
arrives, it opens; offline, it waits in Unsent.

`@` mentions insert `@path`, as the web's composer does. Before a thread exists they search a
device-owned draft scope (`draft.create`, `draft.mention.complete`). Add project searches the
computer's folders (`fs.recentFolders`, `fs.search`) and registers one with `workspace.add`; a
computer that refuses this phone's project requests gets "add it on your computer" instead.

A thread's menu pushes Files (`bridge/checkout-files.ts`, `Views/Files`), at parity with the
web's Files tool. Each screen asks one `native.files` service request at a time. The tree is
the daemon's listing (at most 1,000 paths) in the web's order, folders opened in place, with
`git.status` letters (M, A, D, R, U from `changeLetters`); folders holding a change start open.
The system search field is quick open through `mention.complete`. A file reads like the web's
viewer: up to 2 MB (`checkoutViewLimit`), coloured by the shared grammar highlighter
(`@ace/ui-core/source-highlight`, sent as compact runs for the first 256 KiB of text) with
change bars from `git.diff` (`lineMarks`), in a TextKit 2 view with a fixed line-number gutter
and the system find navigator. Markdown renders with its source a tap away; images draw;
binary and larger files offer Share. Text up to 1 MB edits and saves with `write` over the
version opened; a newer version is only replaced on Replace. Create, rename, move and delete
(to Recently deleted, with Undo and a restore list) use the web's checks and the shared error
sentences (`checkoutError`). An answer's local links route through `checkoutLinkPath`: a
checkout file opens at its line; a file elsewhere is fetched with `link.download` for that
message and shown in Quick Look. New thread's Browse files opens the same screens on the chosen
project's own folder before any thread exists: `files.request` with a `workspaceId` lists,
stats and downloads read-only inside the registered project root. View-only machines browse
but change nothing. `scripts/files-scenario.ts` seeds `ios-files`; `UITests/FilesUITests`
covers it.

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
- Back from the background, every machine's runtime calls the SDK's `wake()`: a ready socket
  must answer a ping within five seconds or is replaced, and a reconnect waiting out its backoff
  runs at once. Screens that read through native services (Files, pull requests and issues,
  Usage, Automations, Prompts, terminal and others) read again each time their machine's
  connection becomes ready (`readWhenConnected`, counted by `ClientModel.readyCount`).

`bun run e2e:pairing` starts a real daemon with its LAN TLS listener advertised on
loopback, plus a redirect trap that holds the daemon's own key. It writes
`/tmp/ace-ios-pairing-e2e/config.json`. With the script running, run
`-only-testing:AceTests/RealDaemonPairingTests` with `test-without-building`; codes
expire in five minutes. These tests skip when the config is absent.

## Connection lifecycle

`--spike` (Debug only) keeps the unpinned loopback fixture. Release builds require WSS
and an exact pin. Pinned pairing, authenticated inbox/service reads and changed-pin refusal have been verified
on a physical iPhone over Tailscale.

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
`UNUserNotificationCenter`; `bridge/notifications.ts` registers the phone (and sends `notification.unregister` while that
machine's alerts are off), reports foreground or
background presence and runs approval actions through the SDK outbox. With the fixture running,
`curl -X POST localhost:9841/review/notify -d '{"threadId":"ios-approval"}'` sends an alert and
`/review/retract -d '{"id":"…"}'` withdraws one. Remote push through APNs or a push gateway remains deferred; see the
[draft](../../docs/adr/drafts/ios-push-notifications.md). Local Live Activities use the
foreground SDK state described below.

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

## Native tools and local Live Activities

[ADR 0089](../../docs/adr/0089-ios-native-tools-and-local-activities.md) records the
service boundary and feature limits. The [simulator progress record](../../docs/verification/ios-emulator-parity/README.md)
tracks verification and the remaining device work.

- Machine settings use that machine's SDK connection for preferences, usage,
  automations, prompt files and provider CLI sign-in. Prompt writes retain revision
  checks. Automation edits preserve configured triggers and schedule anchors.
  Provider continuation handles choices, browser codes and the CLI's Enter prompt.
  API keys remain outside this service bridge.
- Appearance and keyboard settings persist system/light/dark mode, custom light and
  dark palettes, and Return-to-send. Status and diff colours retain their shared
  meanings. Profiles store reusable instructions on the phone and include them
  explicitly in a new task's first message.
- Thread tools include skills and commands, MCP controls, durable conversation
  branches and a terminal. The live browser uses the entry described above. Terminal output acknowledges
  native delivery and resumes by byte offset. Its text renderer supports basic VT
  controls, with 1,000 rows of 80 cells. Lost output resets escape parsing and marks
  the gap. Colour and alternate-screen emulation remain future work.
- The live browser from `main` owns H.264 video, input and tab controls.
  View-only phones can watch while navigation and input remain disabled. The old
  screenshot-only browser has been removed. The native Devices view now uses the shared authenticated devices channel for H.264
  streaming, gestures, controller leases, boot, apps, URLs, appearance and recording.
  Mac app sessions use the separate authenticated screen channel with native H.264/JPEG
  decoding, bounded frame acknowledgement, take/release/return control, touch/keyboard input,
  foreground/background mode and recording. Browse > Computer use exposes the host enable
  switch, OS permissions and blocked-app preferences. Live capture still requires the Mac
  Screen Recording and Accessibility grants. Input is never replayed on reconnect.
- Published images decode into native image views. Published HTML uses `@ace/html`
  inside a nonpersistent WKWebView, without native message handlers or network access.
- A thread's menu can start a local Live Activity. Foreground updates use canonical
  whole-tree status, renew unchanged content every 30 seconds, and mark content stale
  after 60 seconds without renewal. The navigation stack owns renewal while a thread
  is open. Cached Done stays Syncing until the current inbox subscription confirms
  completion; newer state revokes queued endings. Offline content asks the person
  to reopen ace. APNs activity updates are not implemented.

For an unsigned device archive, run `bun scripts/archive.ts --unsigned` from this
folder. For a signed archive, set `ACE_IOS_TEAM_ID` and omit `--unsigned`. Optional
`ACE_IOS_BUILD_NUMBER` and `ACE_IOS_ARCHIVE` select the build number and output path.
Distribution still requires the appropriate Apple team, signing and App Store
Connect access. An unsigned archive cannot be uploaded to TestFlight.

## Browser parity and physical-phone checks

The inbox keeps task creation beside the project filter. Browse exposes projects, past CLI
sessions, automations, usage, CLI skill discovery, plugin installation/review/source/availability,
provider accounts, source control, device inventory and machine settings. Projects and account
administration require their explicit pairing scopes; administrator access alone does not grant
either. Pairing confirmation names these grants. Read-only grants retain their existing limits.

Transcript work uses the same `stepFact`/`groupSteps` rules as the browser. Active work shows
reasoning disclosures and grouped tools with the agent's narration between them; completed
work folds behind its work header. File-summary blocks open Changes instead of repeating
raw edit rows. Tables render natively, and long message/thought text can be read from the
SDK's authenticated text source on demand, bounded to 8 MiB of UTF-16 text. The virtualized
outer list and observed item identities stay in place.

Chat gives the message its own line above attachment, model/reasoning and send/stop
controls. User messages are inset on the right; assistant responses are plain text. Copy,
Share and timestamps are in the message menu, and code blocks have a language/Copy header.
The paired app opens the latest 200 items instead of eagerly hydrating a 2,200-item
benchmark window. The initial items and block layout complete before the transcript appears;
a compact message skeleton fills the loading interval. Live work groups are independent
list rows, and reopening a parent holds its last readable snapshot until the replacement
is ready. Reading older content pauses tail following; Jump to latest resumes it. Conversation history
uses separate bounded SDK windows and keeps page controls reachable below the content, so
long conversations remain readable after the live cache is full. Historical full messages
and media resolve their authenticated item without replacing the live tail.

Projects > Add project also has New project and Clone repository. Their protected local
drafts retain form fields and command IDs across relaunch. A retry of an uncertain result
reuses that command; clone progress and cancellation use the shared daemon operations.

Connected-phone checks are opt-in with `TEST_RUNNER_ACE_IOS_CONNECTED_PHONE=1` and a physical
`platform=iOS` destination. `ConnectedPhoneConnectionTests` uses the saved pairing and a
separate temporary database; it performs read-only checks against the real daemon. The
`ConnectedPhoneUITests` tour reads real screens, opens the keyboard and checks control
placement without starting providers or remote devices. Its screenshots may contain private
conversations, so xcresult artifacts stay local. The one-time pairing repair test is separately
opt-in and never exports Keychain credentials; its old database is retained.
