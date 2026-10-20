# 0064: Daemon-owned in-app devices

Date: 2026-10-02. Status: accepted.

Superseded 2026-10-14: ace's MCP tools are always allowed; permissions are provider-native (owner decision). Device approval is no longer a human prompt: an agent's device call binds the device to its thread without asking.

Superseded 2026-10-20: live views are H.264 at 60 fps only; every JPEG live-view path below is gone (see "Live views are video only").

Renumbered after checking origin/main and open PRs on 2026-10-03. The initial
0063 allocation avoided #90’s 0062. A subsequent check found #90 merged and
#93 reserving 0063, so in-app devices now uses 0064. Web performance keeps 0056.

ace owns iOS Simulators and Android emulators through a single `@ace/devices`
service. A device is an installed simulator or AVD, with a stable platform-prefixed
identity independent of its current process or adb serial. Physical devices remain
outside this first version. The daemon registers the service through its existing
service registry. Clients and MCP tools share its validated operations.

## Ownership and authorization

Only an authenticated admin client can enable devices, approve a device for a
thread, or delegate input to an agent. MCP credentials identify the caller; tool
arguments cannot select a different thread or agent. A device has one expiring
controller lease. Human takeover invalidates queued agent input; disconnect,
revocation, shutdown and restart release control. A restarted daemon requires fresh
approval and never restores input ownership. Device work does not invent provider
completion facts or weaken the whole-tree status rules in ADR 0004.

Authenticated human viewing does not grant agent access. Simulator capture uses a
human-only window session while agent computer use is disabled or the device is
unapproved; macOS Screen Recording permission still applies. This path accepts
only Simulator windows and does not expose semantic reads or agent control.
Approval replaces the capture session, and the client restarts its live view.

## Reuse and transport

iOS inventory and boot reuse `Simulators`; capture and semantic actions use the
approved Simulator window through `ScreenManager`. ace's own code calls no private
CoreSimulator API; the pinned external `serve-sim` binary does (see "Native Simulator
transport"), and the window path stays as the public-API fallback. Timed gestures extend the helper's existing pointer drag
operation, preserving the same target-point coordinates as capture. Direct
platform callers without a window binding can use detected idb. Unsupported operations return typed errors with a fix
hint instead of pretending success.

Android SDK discovery checks ANDROID_HOME, ANDROID_SDK_ROOT and the conventional
SDK directory, resolving adb and emulator by absolute path. Bounded simctl and adb
processes implement lifecycle and app operations. Android accessibility dumps map
to ADR 0011 v2 nodes and refs; actions refresh and validate their target before
synthesizing input, and report that fallback explicitly.

Update (2026-10-19, #1103): Android capture now speaks the scrcpy protocol with
ace's own client and the pinned upstream scrcpy-server (Apache-2.0), downloaded on
first use into ace's home and verified by SHA-256. It is an external, pinned binary
like serve-sim; ace's code is written from scrcpy's documentation. The device's H.264
is passed through, input uses scrcpy's control socket (multi-touch, Unicode by paste,
clipboard, rotation), and UI trees come from ace's own long-running UiAutomation
helper started with `app_process`. The screenrecord pipeline below remains the
fallback when the server cannot start, and `uiautomator dump` remains the tree
fallback.

Android capture uses an owned `adb exec-out screenrecord` H.264 process connected
with stream backpressure to an owned ffmpeg JPEG decoder. Independent JPEG frames
reuse `FrameHub`, `framePacket` and `Recording` from `@ace/screen`. Dropping the
latest queued JPEG is safe, whereas dropping arbitrary H.264 packets is not. No
unverified gRPC endpoint or emulator token discovery is assumed. Capture emits
only changed images and retains at most one current image, one frame per blocked
subscriber and one pending recording frame. Real Android compatibility and
performance measurements need run at merge; no probes are permitted during this
implementation.

Simulator capture rejects duplicate booted display names before selecting a
window. Android capture binds dimensions and pixels to one verified transport
and terminates when inventory changes that identity. Accessibility dump/read/remove
transactions are serialized per device with a bounded queue.

Approval transitions invalidate subscriptions and replace the log ring. They
clear completed recording ownership and wait for pending recording exports.
Capture startup is cancellable and owned until shutdown has awaited its native
handle and termination. Cleanup attempts capture, logs and recordings independently
and aggregates failures instead of publishing an idle state after partial cleanup.
`ScreenStopError.captureTerminated` separates a native stop error from confirmed
release of capture ownership. The device retains the error, but releases a
terminated handle so retry, disable, reapproval and replacement capture do not
address a deleted native session. Unknown termination retains device ownership.

Device control messages are additive schema exports. Binary image packets use the
screen protocol, with device state mapping device identity to stream session id.
The same authenticated connection contract applies locally and over the encrypted
relay. Logs have bounded chunks and tails, never an accumulating JSON transcript.
Recordings reuse the bounded screen writer, then export frame payloads one at a
time through the existing browser MP4 encoder. The file-transfer artifact
registry publishes the result and streams downloads. No recording body travels
in a JSON control message.

The portable device client is exposed by `@ace/client` as `DeviceClient`,
`deviceTransport` and `authenticatedChannel`. Injected sockets and Noise keys
support authenticated local and pinned relay connections without Node-only
transport dependencies. `downloadArtifact` streams registered files into an
awaited sink. The existing `@ace/devices/view` export remains available.

The owner assigns all UI code to Claude agents. Web/Electron mounting and Expo
rendering/gestures belong to that workstream; this PR contains no `apps/web`
changes or mobile UI. The public client never replays input after reconnect.

## Agent parity

The daemon composes browser, screen and device toolkits before opening any provider
session. It issues a session-scoped MCP credential and passes the same connection
contract through every adapter. Adapters inject it using their native MCP support;
unsupported native support fails explicitly rather than silently losing tools.
App/device approval remains a human operation, outside the agent tool catalog.

OpenCode v2 keeps account pooling for ordinary sessions. A scoped ace MCP
connection uses a separate owned server because native MCP configuration is
process-wide. Its close awaits termination before removing the bounded pool
entry. Configured servers are preserved; an `ace` name collision and injection
into an external server fail explicitly. Pi reuses the daemon-issued lease
instead of issuing a narrower second lease. Its extension accepts the browser,
screen and device namespaces and projects MCP errors for each. Read-only Pi
continues to withhold MCP tools under its existing permission contract.

Primary references: [Android adb](https://developer.android.com/tools/adb),
[emulator console](https://developer.android.com/studio/run/emulator-console),
[idb UI](https://fbidb.io/docs/idb/ui/), and the installed Xcode simctl interface.
The t3code release notes were read as a feature reference only. No source code
from t3code or ace-legacy was read or reused.

## Live view repair (2026-10-04)

The owner booted an iOS Simulator from the Devices tab and saw "Off" with no screen. The
causes, and the decisions that replace the behaviour:

- A boot or shutdown changed the simulator but not the session's device record, so every
  pushed state still said "shutdown" until someone listed devices again. Boot and shutdown now
  re-read the inventory before answering, and every changed device state is pushed.
- Nothing noticed a simulator booted or shut down outside ace. While devices are enabled and a
  Devices view holds an `inventory.watch` lease on its connection (released with the view or the
  connection), the service re-reads the inventory every four seconds and pushes
  `devices.inventory` when it changed. State observers, such as the main channel, never cause
  background reads. Lifecycle acknowledgements wait for a read that started after the change
  rather than joining one already in flight.
- Turning devices on or off is pushed to every connection as `devices.enabled`, so views with no
  device sessions follow it.
- The live view required the device to be approved for a thread, because only thread approval
  approved the Simulator bundle for capture. A person starting the view now approves the
  Simulator window for capture themselves; agents still need the thread approval.
- The daemon pushed `screen.state` and project changes to every authenticated connection,
  including the dedicated devices channel, whose client rejected them and disconnected. Feature
  pushes go to the channels that carry that feature, and the devices client skips messages of
  other features instead of failing.
- A failed capture startup was reported a second time by cleanup, as "Device resource cleanup
  failed". Cleanup of a startup that owns nothing is silent; the startup's own error stands.
- A missing macOS permission surfaced as a generic error, if at all. `DeviceFailure` gains an
  optional `permission` (`screenRecording` or `accessibility`); `permissions` reports the
  helper's permissions and `permissions.request` (human only) asks macOS for one on the
  daemon's Mac. The app shows which permission is missing, where to turn it on, a button that
  opens that pane, and Try again.
- The app starts the live view after Boot and when a running device's tab opens, once per
  device per tab; a failure waits for Try again.
- Device request and live-view failures go to the daemon's redacting log: refusals a person
  can act on at `info`, faults at `warn`, inventory read failures once per distinct cause.

macOS-side causes (permission attribution, Simulator windows on another Space, keyboard focus
and Simulator key codes) are recorded in ADR 0011.

## Device actions and explicit sharing, 2026-10-07

Opening an iOS device tab does not enable computer use or grant Simulator access. The
person approves the device for the current thread before its live view starts. The approval
copy explains that this enables computer use and grants Simulator to that thread. Revoking
or disabling devices removes that grant; cleanup failure must not leave the grant behind.
Other approved iOS devices in the same thread retain their shared Simulator grant.

Agent device tools ask through the blocking host approval machinery before operating an
unapproved device. Allow for this thread enables devices, approves the selected device and
delegates it to the requesting agent. Denial, cancellation and expiry perform none of those
steps. Existing human controller leases remain authoritative.

The device menu owns installation, opening URLs/apps, settings, screenshots and recordings.
Stopping or completing a bounded recording publishes a registered MP4 and a thread artifact.
Artifacts carry an optional opaque download identity; clients reuse the bounded file preview
and native video controls. The wire adds optional device recording state and a device artifact
source. Browser artifacts remain compatible.

Computer-use Take over pauses the agent. Its view does not yet forward pointer or keyboard
input, so its status says "Agent paused". Sharing an app/window approves it for this thread,
starts a session and delegates to the thread's root agent. Sensitive apps use the current
turn grant instead. The picker leaves an explicit grant visible if starting or delegation
fails, and cleans up any session it started.

### Native Simulator transport

When a pinned `serve-sim` is installed on the device's Mac, capture uses its CLI
(`--no-preview --quiet <UDID>`), its H.264 or MJPEG framebuffer stream, its
persistent WebSocket HID channel and its accessibility route. `ACE_SERVE_SIM` can
select an explicit executable. Install with `npm install -g serve-sim@0.1.48`; the
desktop daemon includes the user's CLI paths. The legacy screen-helper path remains
available on Macs without it. An explicit missing `ACE_SERVE_SIM` is an error, never
a silent fallback.

Revised 2026-10-19 (#1102):

- **Preferred and pinned.** serve-sim is the preferred iOS transport. It stays an
  external binary that ace spawns and supervises; it is never bundled or copied, and
  ace's own code keeps to public APIs. serve-sim drives private CoreSimulator,
  SimulatorKit and AccessibilityPlatformTranslation interfaces that move between Xcode
  releases, and its HTTP routes are not a published API, so ace runs only versions it
  has checked (`serve-sim-version.ts`: 0.1.47 and 0.1.48; 0.1.48 is the install hint).
  Capture asks `serve-sim --version` before each start. Any other version falls back to
  the screen helper, or fails with `tool_missing` naming the pinned version when there
  is no helper or `ACE_SERVE_SIM` names it explicitly. Moving the pin means re-running
  `simulator-live.process.test.ts` and the measurements in
  `docs/device-mirroring-performance.md` on the new version.
- **H.264 passthrough.** Viewers that negotiate H.264 get `/stream.avcc` as-is: each
  length-prefixed access unit is re-framed as Annex B, a keyframe led by the SPS/PPS
  from serve-sim's avcC record, and published with `videoCodec` from that record
  (`avc1.640033`, High 5.1, on current iPhones). Nothing is decoded or re-encoded, so the
  frame is the native framebuffer size whatever the viewer's budget; the frame header's
  height limit is 3840 to admit portrait phones. A keyframe request opens a second
  subscription (serve-sim starts every subscription with its description and an IDR),
  switches at that IDR and closes the old one, so the picture never stops. A new avcC
  record (size change) is honoured at its next IDR. While H.264 is live the MJPEG stream
  is closed; viewers that need JPEG (no decoder for the profile, screenshots,
  recordings) get the MJPEG stream through the existing bounded resize path.
  Clients configure WebCodecs from `videoCodec` and fall back to JPEG only when the
  decoder reports the configuration unsupported.
- **Input.** Touches keep the HID socket. A drag or swipe that begins within 2% of a
  screen edge carries serve-sim's edge flag, so swipe-up-from-bottom goes home; taps
  never do. Rotation toggles from the orientation serve-sim announces on the socket,
  because its framebuffer stays portrait. Pictures and touch coordinates stay in that
  portrait framebuffer when the device turns, so each frame carries `rotation` (degrees
  clockwise to show it upright: `landscape_left` 90, `portrait_upside_down` 180,
  `landscape_right` 270) and a turn republishes the latest picture. Pointer ids 0 and 1
  map to serve-sim's two-finger touch: a second finger joins the held touch without
  lifting it (a lift would be a tap), and the finger left after a two-finger touch only
  touches again once it moves. Ids above 1 are refused as `not_supported`.
- **Accessibility.** `ui.tree`, `ui.find` and `ui.act` on a serve-sim capture read its
  in-process accessibility bridge (`GET /ax`, a nested tree in points) and map it to
  ADR 0011 nodes in framebuffer pixels, with refs hashed from the element's path, type,
  identifier, label and bounds. A ref that no longer resolves in a fresh read is
  `stale_ref`. `ui.act` taps the centre (or swipes, for scroll) through the HID socket.
  The SSE push stream serve-sim's preview uses lives in its preview middleware, not in
  the `--no-preview` helper ace runs, so reads are on demand.
- **Xcode gates.** Xcode 26 and older use the legacy SimulatorKit HID path. On Xcode 27
  the Simulator window belongs to Device Hub: serve-sim's keyboard input needs Device
  Hub frontmost with the target window visible and Accessibility permission for the
  launching app, and Device Hub can disconnect legacy touch and keyboard services.
  `serve-sim repair-input -d <udid>` restores them but restarts SpringBoard and closes
  running apps, so ace never runs it automatically; it is a documented manual repair.
  serve-sim is Apple Silicon only; Intel Macs use the screen helper.

The adapter validates the announced UDID and loopback endpoints before opening
any connection. Frame decoding is bounded, retains only the latest immutable
packet, and reuses the existing authenticated device/relay frame transport.
Native capture does not select windows by name and does not require macOS Screen
Recording. Input stays behind the existing controller lease; gestures recheck
that lease between native dispatches. Keyboard input uses serve-sim's public
stdin command and reports its supported-keyboard/permission failures honestly.

The supervised CLI owns any helper it starts. A pre-existing serve-sim server is
borrowed: ace closes its own stream and HID socket without killing that server.
Android uses bounded JPEG output from the owned screenrecord/ffmpeg pipeline.
H.264 negotiation falls back to JPEG until subscribers can recover dropped frames
without restarting native capture. Rotation is read for each capture cycle; unchanged
stream settings and nearby panel sizes preserve the pipeline.

### Audit reliability fixes

Queued boot, install and input actions retain their controller ticket until completion.
Takeover still invalidates the ticket. An agent may resume its own expired delegation
on its next authorized action; explicit release, disconnect, revocation and takeover prevent this.
Boot state is visible separately from capture startup. Inventory reads preserve loading
and failure states, cache Android identity until disconnect, and queue SDK commands.
Only resolved AVD names enter the cache; failed probes retry on later inventory reads.

Approval still replaces scoped capture resources, but the service restores a previously
live capture and mounted viewers subscribe to the replacement. Failed native cleanup
offers a retry. First-frame deadlines begin after capture opens. Simulator throttling
publishes the trailing frame. Android console shutdown waits for exit before signalling.

Native installs have a ten-minute command budget. Their MCP tool deadline allows another
30 seconds for dispatch and completion; provider configurations and the registry ceiling
allow up to eleven minutes. Pi accepts the same bounded advertised deadlines, and the
ACP stdio bridge retains tool calls for that budget.

Recording imposes a 1280×720, 15 fps image budget and a 512 MiB source limit shared
by capture, export validation and encoder frame admission. MP4 output retains its
separate 50 MiB limit. Automatic stops and failed exports produce a visible notice;
consumed source files are deleted
even after export failure. Logs filter iOS processes, batch updates and retain consumers
independently. Congested sockets coalesce state pushes rather than closing the channel.

## Shared media stream, 2026-10-19 (#1118)

Device pictures leave the screen packet format and travel as stream kind 4 `deviceFrame` on
the envelope the browser view already uses (`@ace/browser/stream`, ADR 0088). One header
carries a JPEG or one H.264 access unit, with the sequence, capture time, size, `scale`
(pixels per device point), `rotation`, a keyframe flag, the codec, the device id (the source
id) and the capture's stream id. H.264 stays Annex B with parameter sets in front of every
keyframe, as scrcpy and serve-sim hand it over, so the daemon still never decodes it.

- **Why the browser's envelope and not a new package.** The envelope, assembler and the
  video fanout are already portable and decoded natively by the iOS app. Moving them into a
  `media-stream` package would rename every import of `@ace/browser/stream` for no change in
  behaviour; the device kind is one more module beside the browser kinds, and
  `VideoFanout` is exported as `@ace/browser/video-fanout` for the devices bridge.
- **Pacing.** Each connection's view of a device is a `DeviceMediaViewer`: the browser
  video's window (8 unacknowledged pictures, 2 MiB), its drop rule (a delta that doesn't fit
  is dropped with every later delta until a keyframe, which is asked for at once) and
  cumulative acks (`devices.ack`, fire and forget, naming the stream id). A JPEG is always a
  keyframe, so a slow JPEG viewer gets the newest picture when its window opens. Forced
  keyframes are at most 500 ms apart per viewer. The viewer takes every captured frame in
  order (`subscribeEvery`), not the hub's newest-only delivery, so no delta is lost before
  the window decides. A viewer also stops while its transport holds more than 128 KiB, the
  limit screen packets had, so control replies on the same channel never queue behind pictures.
- **Compatibility: none (#1129).** The one release of both formats ended with ADR 0011
  "One media pipeline": `subscribe` always streams pictures (the `mediaStream` flag is
  gone), the daemon sends no screen packets, and a screenshot is a still picture on the
  stream followed by the result that names it (`DeviceScreenshot`). The paced viewer moved
  to `@ace/browser/picture-channel`, shared with computer use.
- **Renderer.** The web app decodes device H.264 with the browser view's `VideoStream`
  (moved to `apps/web/src/lib/video/`), so both views share one WebCodecs path; since #1129
  the renderer itself is `lib/video/picture-renderer.ts`, shared with computer use. A
  `NotSupportedError` falls back to JPEG at once; other decode errors ask for a keyframe and
  give up on video after three in a row. A hidden page holds its newest ack, so the daemon
  stops sending, and acks it with a keyframe request when the page shows again.
- **Rotation.** `rotation` is the turn that shows the picture upright. The canvas draws it
  turned; input maps back through the inverse turn into the picture's own coordinates,
  which is where serve-sim's touches land. scrcpy re-sizes its stream on rotation, so
  Android sends 0.
- **Touch.** Device state carries `touch`: `multi` (scrcpy, serve-sim), `pointer` (one
  finger streamed live) or `gestures` (the adb fallback). The panel reads touches through the
  browser's `TouchGestures` (moved to `apps/web/src/lib/touch-gestures.ts`) and sends each
  finger as `pointer` input with its `pointerId`; Option-drag with a mouse adds a mirrored
  second finger for pinch, as Simulator does.
- **Relay.** Remote status (`/v1/status`, administrators) names the relay's address, the
  host key a client pins and the daemon's identity while the relay runs. The web app's
  devices channel tries the daemon's own address first and, when that closes before the
  welcome, the remembered relay route with fresh keys and the paired token, then sizes
  the stream with the relay profile.
- **Bit rate.** scrcpy's size, frame rate and bit rate follow the most constrained viewer
  (`commonDeviceStream`); one emulator has one encoder, so viewers don't get separate
  encodes. serve-sim's H.264 passes through at serve-sim's own rate, whatever the profile
  asks: on an iPhone 16 simulator through a local relay (`apps/daemon/bench/device-relay.ts`),
  0.1–0.3 Mbit/s idle and 0.1–0.8 Mbit/s paging the home screen. None of its deltas were
  disposable (`nal_ref_idc` 0 in none of 2,125), so frame-rate decimation without a
  transcode isn't possible; a slow viewer relies on the window's drop rule, and a viewer
  asking for JPEG gets the resized, budgeted JPEG path.

## Live views are video only, 2026-10-20

Owner decision: a live device view is H.264 at 60 fps, on the same desktop, over Tailscale and
through the relay to mobile web. JPEG is never a live-view format. This supersedes the JPEG
fallbacks above (MJPEG and ffmpeg JPEG for viewers without a decoder, the JPEG answer to a
`NotSupportedError`, the screenshot and recording switches to JPEG, and the screenrecord view).

- **Profile.** `deviceStreamProfile` asks for 60 fps and H.264 on every connection: local
  12 Mbit/s in a 3840×3840 box, remote 8 Mbit/s in 1440×2880 (a phone screen at its device pixel
  ratio), relay 5 Mbit/s in 1080×2160. Pressure (0–3) divides the bit rate by 1 + pressure/2, never
  below 1 Mbit/s, and at 3 shrinks a remote or relay box to three quarters. It never lowers the
  frame rate. scrcpy gets `max_fps=60` and the profile's `video_bit_rate`; serve-sim encodes at
  60 fps and 6 Mbit/s and takes no options, so its stream passes through as before.
- **No JPEG to a viewer.** A viewer's preference is always H.264 (a JPEG `stream.configure` is
  `not_supported`); before it sizes its stream it asks for 60 fps in the remote box. While anyone
  watches, the capture streams H.264 whatever else uses it. A capture that can't refuses the
  view rather than downgrading it: the Simulator screen helper without an H.264 encoder with
  `tool_missing` and `npm install -g serve-sim@0.1.48`, serve-sim video that won't start with a
  reinstall hint, and the Android screenrecord fallback with `not_supported` naming why scrcpy
  didn't start. The bridge drops any JPEG frame, so the JPEG a capture makes for agents' stills
  and recordings while nobody watches never reaches a view.
- **Stills and recordings.** A screenshot of a watched device comes from the device (`simctl io
screenshot`, `screencap`). A watched recording decodes the live H.264 through ffmpeg to its own
  1280×720, 15 fps JPEG budget (`RecordingFeed`); an unwatched one still sets that budget on the
  capture. JPEG and PNG remain for screenshots, model screenshots and recordings only.
- **Clients.** The web view always asks for H.264 and has no JPEG decoder; without a WebCodecs
  H.264 decoder, or when the platform refuses the stream, it shows "This browser can't decode H.264
  video", and a refused stream shows the daemon's message and hint. The iOS reader marks stills
  and exposes `isLiveVideo`. The fake daemon streams real H.264 IDRs of its screens.
