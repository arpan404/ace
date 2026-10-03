# 0053: Daemon-owned in-app devices

Date: 2026-10-02. Status: accepted.

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

Device control messages are additive schema exports. Binary image packets use the
screen protocol, with device state mapping device identity to stream session id.
The same authenticated connection contract applies locally and over the encrypted
relay. Logs have bounded chunks and tails, never an accumulating JSON transcript.
Recordings reuse the bounded screen writer, then export frame payloads one at a
time through the existing browser MP4 encoder. The file-transfer artifact
registry publishes the result and streams downloads. No recording body travels
in a JSON control message.

The portable client and reusable DOM panel live in `@ace/devices` client/view
exports. This branch contains daemon and relay applications, so actual
web/Electron mounting and an Expo native renderer remain host integration work.
The portable client carries the same contract over local and paired relay
connections without replaying input after reconnect.

## Agent parity

The daemon composes browser, screen and device toolkits before opening any provider
session. It issues a session-scoped MCP credential and passes the same connection
contract through every adapter. Adapters inject it using their native MCP support;
unsupported native support fails explicitly rather than silently losing tools.
App/device approval remains a human operation, outside the agent tool catalog.

Primary references: [Android adb](https://developer.android.com/tools/adb),
[emulator console](https://developer.android.com/studio/run/emulator-console),
[idb UI](https://fbidb.io/docs/idb/ui/), and the installed Xcode simctl interface.
The t3code release notes were read as a feature reference only. No source code
from t3code or ace-legacy was read or reused.
