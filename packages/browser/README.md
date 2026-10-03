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
ace-owned profile. Persistent profiles have exclusive workspace leases.

The desktop bridge contract is [ADR 0055](../../docs/adr/0055-browser-backends.md).
`BrowserBackend` opens a session with a CDP transport and page operations.
`HeadlessBackend` wraps Playwright; `registerEmbedded` attaches an authenticated
transport after the daemon has verified its local desktop credential. Agent
and client commands keep using `BrowserService`. `browser.backend` can be
`auto`, `embedded` or `headless`, with thread overrides through settings.
Desktop disconnect emits `browser.backend.lost` and pauses by default.
`browser.backendLoss: headless` reopens the last approved URL in an ephemeral
headless profile, keeps the controller lease and reports `pageStateLost: true`.
It preserves subscriptions, advances frame sequence numbers and invalidates
old refs. Pending commands fail and never replay.

`execute` accepts commands defined by `BrowserCommand` in `@ace/protocol`.
Screenshots and logs return local paths. Evaluate requires its own injected
approval and limits serialized output to 256 KiB of UTF-8. Renderer preflight
uses primitive string operations; the daemon validates byte size and parses JSON,
so page replacements of builtins cannot bypass the result cap. Navigation and intercepted HTTP,
redirect and WebSocket requests allow exact loopback names, and ask the origin
hook for every other site. The hook should store approval decisions outside this
package. Service workers, downloads and popup pages are disabled. CDP interception
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
nodes fail explicitly instead of collecting an arbitrarily large tree. AX snapshots
describe the primary document; this version does not expose iframe element refs.

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
and capture rate drop from JPEG 70 at up to 15 FPS to JPEG 40 at up to 6 FPS under
pressure. CDP captures changed frames, not a heartbeat. Capture dimensions are
limited to 1280 by 960; frame width/height describe the CSS viewport for mapping
pointer and touch coordinates.

Take-over is immediate. Agent input checks ownership when it reaches dispatch
and after awaited preparation. An action already sent to Chromium may finish.
Human commands and input require the same controlling connection; read commands
remain available to viewers and agents. Disconnect returns control to the agent.
Queued commands are capped at 32 per session. There are at most 8 sessions and
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
permission/download denial hooks. Both implementations deny permissions and
downloads; Electron emits audit events after denying them locally.

New behavior tests cover a real socket fake desktop and a local HTTP archive
server. Relay and acquisition benchmarks live in `bench/relay.ts` and
`bench/acquisition.ts`. Tests, mutations and benchmarks were not executed under
the owner's merge-only policy. Runtime results and throughput need run at merge.
