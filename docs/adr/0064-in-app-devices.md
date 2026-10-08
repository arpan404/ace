# 0064: Daemon-owned in-app devices

Date: 2026-10-02. Status: accepted.

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

## Reuse and transport

iOS inventory and boot reuse `Simulators`; capture and semantic actions use the
approved Simulator window through `ScreenManager`. There is no private
CoreSimulator API. Timed gestures extend the helper's existing pointer drag
operation, preserving the same target-point coordinates as capture. Direct
platform callers without a window binding can use detected idb. Unsupported operations return typed errors with a fix
hint instead of pretending success.

Android SDK discovery checks ANDROID_HOME, ANDROID_SDK_ROOT and the conventional
SDK directory, resolving adb and emulator by absolute path. Bounded simctl and adb
processes implement lifecycle and app operations. Android accessibility dumps map
to ADR 0011 v2 nodes and refs; actions refresh and validate their target before
synthesizing input, and report that fallback explicitly.

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
