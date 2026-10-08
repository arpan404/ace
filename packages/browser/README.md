# @ace/browser

Daemon-owned Chromium sessions, with agent automation and a live view shared by
desktop, web and phone clients. No Electron dependency. See
[ADR 0009](../../docs/adr/0009-browser-service.md).

```ts
import { BrowserService, installChromium } from "@ace/browser";

const browser = new BrowserService({
  dataDir: "/path/to/ace-data",
  originPolicy: async ({ threadId, origin }) => approvedSites.has(`${threadId}:${origin}`),
  evaluatePolicy: async (threadId) => approvedEvaluation.has(threadId),
  onArtifact: async (threadId, artifact) => saveThreadArtifact(threadId, artifact),
});

await browser.open({ threadId, workspaceId, profile: "ephemeral" });
await browser.execute(threadId, { action: "navigate", url: "http://localhost:3000" });
const snapshot = await browser.execute(threadId, { action: "snapshot" });
// Use a ref from the returned nodes for click, type, press or wait_for.
await browser.execute(threadId, { action: "type", ref, text: "hello" });
await browser.startRecording(threadId);
const artifact = await browser.stopRecording(threadId);
await browser.close();
```

New sessions prefer a connected ace desktop backend. Without desktop, first use
streams pinned Chromium 153.0.8010.12 into `dataDir/chromium`, verifies its
publisher checksum before extraction and publishes the installation atomically.
`installChromium(dataDir, acquisitionOptions)` uses the same verified path.
Downloads report progress through `onDownload` and `browser.download.progress`.
Production startup never searches personal Chrome installations or profiles.
`detectChromium` remains a diagnostic and test discovery API; the trusted
`executablePath` option supports CI and packaged executables, always with an
ace-owned profile. Persistent profiles are isolated by workspace and thread.

The desktop bridge contract is [ADR 0055](../../docs/adr/0055-browser-backends.md).
`BrowserBackend` opens a session with a CDP transport and page operations.
`HeadlessBackend` wraps Playwright; `registerEmbedded` attaches an authenticated
transport after the daemon has verified its local desktop credential. Agent
and client commands keep using `BrowserService`. `browser.backend` can be
`auto`, `embedded` or `headless`, with thread overrides through settings. Agent
opens (`background`) get the same choice, so agents drive the desktop's native
view when one is registered; `auto` falls back to headless when the desktop
cannot open a view ([ADR 0069](../../docs/adr/0069-shared-native-browser.md)).
`profilePreference` fills an open without a profile; `forgetThread` closes a
deleted thread's browser and purges its persistent profiles.
Desktop disconnect emits `browser.backend.lost` and pauses by default; the
agent's next open resumes a paused page headlessly unless a person holds it.
`browser.backendLoss: headless` reopens the last approved URL in an ephemeral
headless profile, keeps the controller lease and reports `pageStateLost: true`.
It preserves subscriptions, advances frame sequence numbers and invalidates
old refs. Pending commands fail and never replay.

`execute` accepts commands defined by `BrowserCommand` in `@ace/protocol`.
Client screenshots return local paths; logs return bounded inline entries. Evaluate requires its own injected
approval and limits serialized output to 256 KiB of UTF-8. Renderer preflight
uses primitive string operations; the daemon validates byte size and parses JSON,
so page replacements of builtins cannot bypass the result cap. Navigation and intercepted HTTP,
redirect and WebSocket requests allow exact loopback names, and ask the origin
hook for every other site. The hook should store approval decisions outside this
package. Service workers and native permissions remain disabled. Headless sessions admit policy-checked popup tabs and quarantined downloads. CDP interception
also attaches to isolated iframe and worker targets.
One service-wide admission limit allows at most 32 unsettled approval hooks across
navigation, HTTP/redirect/worker interception, WebSockets and evaluate. Excess
requests fail closed without invoking the hook or allocating a timeout. Hooks
receive a session-scoped `AbortSignal` (origin request `signal`, or evaluate's
third argument) and have a ten-second caller deadline. Closing a thread cancels
its calls; service shutdown cancels all calls. A hook that ignores cancellation
keeps its admission slot until it settles, so retries cannot accumulate work.
Future interactions should store approvals separately and let the hook return a decision.

Snapshots include AX nodes, parent-child links, ignored-node markers and stable
DOM refs. Only refs from the latest snapshot remain actionable. A navigation
invalidates them; an unrelated DOM edit does not. Snapshot output is bounded to
10,000 nodes, 512 KiB and AX depth 20. Documents with more than 20,000 live DOM
nodes fail explicitly instead of collecting an arbitrarily large tree. AX snapshots include same-origin and cross-origin frames with frame-qualified refs.

## Live view and control

`connectBrowser(service, { connectionId, authorize, send })` connects an already
authenticated transport. The daemon mounts it on its existing socket after
`hello`. `authorize` receives a thread id, the workspace id for open, and the required
`read` or `operate` access. The daemon applies paired-device scopes: viewing,
acknowledgements and inspection require read; browser creation, control and
recording require operate. Device revocation disconnects its controller.
`send` must return false when the transport cannot accept a frame. It receives an
optional shared serialized string so WebSocket clients don't serialize a JPEG
separately for each viewer. Reliable result/state messages must be delivered or
the connection closed. The daemon does the latter under transport pressure.

Clients send `browser.open`, `browser.subscribe`, `browser.ack`,
`browser.takeover`, `browser.input`, `browser.handback`, `browser.execute`,
`browser.recording.start`, `browser.recording.stop`, `browser.unsubscribe` and
`browser.close`. Requests have a `requestId` and a `threadId`, except open which
has `options: BrowserOpen`. Input is one of mouse, key, scroll or touch. Keyboard input translates validated
key/code pairs to CDP virtual key codes so editing and navigation work as well
as character insertion, including numpad navigation and arithmetic. Unsupported codes and inconsistent named keys fail
explicitly; clients can use `char` for text composition, delivered through CDP `Input.insertText`.
Responses are `browser.result`, `browser.state` and `browser.frame`. See the
exported browser schemas for field definitions.

After rendering a frame, acknowledge its `sequence`. Each viewer gets one
in-flight frame and one replaceable latest frame. Slow viewers cannot hold back
others. A new subscription gets the latest captured frame and current state.
CDP acknowledgements happen independently of client acknowledgements. Quality
and capture rate drop to JPEG 40 at up to 6 FPS after sustained pressure. Local
viewers report CSS pane size and DPR through `browser.capture`, capped at 2560
pixels on the long edge with a 30 FPS / JPEG 90 target. Remote demand is capped at
1280 pixels with a 15 FPS / JPEG 80 target. CDP captures changed frames, not a
heartbeat. Frame width/height describe the CSS viewport for mapping pointer and
touch coordinates. Capture demand follows page replacement and reconnects.

Take-over is immediate. Agent input checks ownership when it reaches dispatch
and after awaited preparation. An action already sent to Chromium may finish.
Human commands and input require the same controlling connection; read commands
remain available to viewers and agents. Shared disconnect returns control to the agent. Private takeover blocks agent reads and recordings; a private disconnect pauses until explicit human handback.
Queued commands are capped at 32 per session. There are at most 8 sessions, 8 tabs per session, 32 tabs across the service and
64 viewers per session. Reconnects must subscribe again. A closed browser also
requires a fresh subscription after reopening.

## Files and recordings

Session directories live in `dataDir/browser`. Console and network logs are
JSONL, with lines capped at 8 KiB and each file capped at 16 MiB. Writable-stream
backpressure drops new log entries. Network logs contain URLs, methods, statuses
and failures, with no headers or response bodies.

Recording writes one JPEG at a time, dropping frames while disk is busy. It
streams timestamps to `frames.jsonl` and ffmpeg timing instructions to
`frames.ffconcat`. Stop encodes an MP4 when ffmpeg is on PATH. Encoding failure
returns the frame player instead, preserving the recording. The sequence stays
on disk so timestamps and original dimensions survive encoding. Each recording
is capped at 256 MiB of JPEGs and 100,000 frames; MP4 output has a separate
256 MiB limit. Stop reports an artifact through `onArtifact`, and the daemon
persists an `artifact` thread item. Close finalizes an active recording too.

The fallback `player.html` streams the manifest with bounded memory. Serve the
recording directory through the artifact transport or a local HTTP server to
play it; opening it as a `file:` URL cannot fetch the manifest. Artifact retrieval
is a separate transport concern. This package returns host paths and never
embeds large files in socket messages. Profiles, screenshots and recordings
contain page data and remain in private directories on the host.

## Verification

Run `bun run test -- packages/browser apps/daemon/src/browser.process.test.ts` for real
Chromium plus public API tests, or `bun run check` for the repository checks.
Browser suites skip if discovery finds no executable. CI has a separate Linux
job that installs Chromium and its system dependencies.
The disposable Ubuntu CI runners enable user namespaces for their lifetime so
Chromium's sandbox can run. The CI helper refuses to run outside GitHub Actions.
Ubuntu hosts can need an AppArmor profile for downloaded Chromium; follow
[Chromium's sandbox setup guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

Run `bun run --filter @ace/browser bench` for non-gating fan-out and log-ingestion
measurements, CDP validation with shared frame serialization, and recording writes. The evaluation benchmark measures trusted UTF-8 decoding
and real Chromium result guarding/CDP round trips separately. Under the owner's
current policy these benchmarks and all runtime tests run only at merge; current
measurements need run at merge.
Browser/encoder and transport costs are measured separately from the pure delivery loop.

## Process boundaries

`BrowserServiceOptions.launchContext` replaces the headless Playwright launcher;
`headlessBackend` replaces the backend itself. `acquisition.fetch` and a pinned
artifact replace the download boundary. `spawn` controls encoder and diagnostic
processes. `now` and `id` remain injectable. The backend contract exposes native
permission/download denial hooks. Both implementations deny permissions. The legacy Electron bridge denies downloads; the background headless backend quarantines approved downloads.

New behavior tests cover a real socket fake desktop and a local HTTP archive
server. Relay and acquisition benchmarks live in `bench/relay.ts` and
`bench/acquisition.ts`. Tests, mutations and benchmarks were not executed under
the owner's merge-only policy. Runtime results and throughput need run at merge.

## Agent tools

`browserToolkit(service)` registers `ace_browser_navigate`, `click`, `type`,
`press`, `scroll`, `snapshot`, `screenshot`, `evaluate`, `wait_for`, `logs`,
`resize` and `emulate`, each with the `ace_browser_` prefix. The daemon composes
this toolkit before opening provider sessions. Arguments cannot override the
credential's thread identity. The daemon adds `ace_browser_open` and `ace_browser_close`, deriving workspace
identity from the attributed thread and automatically selecting the backend.
Command registration lives in this package; the daemon supplies lazy opening.
Agents cannot approve origins or evaluation.

MCP screenshots return bounded JPEG image content directly from the owned page.
The client browser screenshot command still writes a PNG artifact. Human takeover
blocks agent input, and ending the MCP credential cancels input awaiting dispatch.
The queue and origin/evaluation policy checks are the same as the public browser API.

The MCP browser and provider-composition behavior tests were written but not run.
They need run at merge under the owner's current verification policy.

## Background browser parity

See [ADR 0067](../../docs/adr/0067-browser-parity.md) and the
[UI wire handoff](../../docs/daemon/browser-parity-ui.md). The daemon's automatic
backend prefers a registered desktop backend for human opens; agent open requests
background operation explicitly and remains headless. Existing sessions keep their
backend until closed. Agent use converts an agent-owned embedded session to a fresh
headless context. Human ownership blocks that conversion.

`ace_browser_tabs` accepts operation list/open/switch/close and optional tabId/url.
`ace_browser_open` also accepts newTab. Stable tab IDs select pages without any
visible desktop view. `ace_browser_upload`, `dialog`, `hover`, `drag`, `select`,
`check`, `uncheck`, `focus`, `find`, `network_body`, `record_start` and `record_stop`
join the existing MCP commands. Actions select the active tab by default; an
optional tabId selects it explicitly. Tab switching expires the old snapshot.

Downloads need origin permission and the injected download policy. They have a
64 MiB file cap, a 256 MiB session aggregate cap, and executable/archive flags.
Completed downloads use the existing artifact sink. Uploads resolve workspace and
artifact paths; outside paths need the injected upload policy. Dialogs remain in
state as pending_dialog until answered. Read-only evaluate uses an isolated world
and CDP throwOnSideEffect. It cannot read page-world variables and can refuse
harmless operations it cannot prove safe. Full evaluation still needs the separate
policy. The daemon wires these policies to canonical engine host interactions.

Logs return entries inline, filtered by kind, level, URL substring and status,
with at most 200 entries. Network bodies are retrieved individually, capped and
redacted through @ace/redaction. No request bodies or response headers are kept.
Private takeover excludes agent observations, logs, network inspection, downloads
and recorded frames. Shared takeover retains agent observation access.

`node packages/browser/bench/crisp.ts` measures a local CSS animation and click-to-decoded
pixel latency in an isolated Chromium context. It prints encoded dimensions, mean JPEG
bytes, delivered fps, median latency and starting host load. It excludes the daemon's
command and viewer WebSocket routing. Run timing comparisons on an otherwise idle host.

`ace_browser_measure_interaction` observes the current tab or dispatches an optional
`interaction` using the existing click/type/press/scroll/drag command shape. The
recording window defaults to 2 seconds, is capped at 10 seconds, and `repeat` is
1–5 with at most 20 seconds recorded in total. Observation uses read access;
input and explicit tab selection retain existing controller and approval fences.

Frame updates come from renderer-scoped CDP compositor trace events, with refresh
cadence inferred from BeginFrame events. An isolated-world trace marker correlates
input dispatch with the trace's monotonic clock. Results include long tasks on that
renderer's main thread and the largest CLS session within the recording window.
Long tasks can include contention from other tabs sharing that renderer.
The optional JPEG filmstrip retains sixteen candidates from the existing live
capture and returns one grid of up to eight timestamped images. It does not drive
frame timing. Tracing and live capture overhead inside Chromium are excluded from
the reported host processing percentage. Headless refresh cadence can be virtual.
