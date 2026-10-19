# In-app devices

`@ace/devices` owns iOS Simulator and Android emulator discovery, lifecycle,
capture, input, accessibility trees, logs and recordings. The daemon starts it
through the service registry. It shares the existing screen manager, frame format
and frame hub, and publishes MP4 recordings through the file artifact registry.
There is no provider login or credential handling here.

## Public APIs

- `@ace/devices` exports `DevicesService`, `DevicePlatform`, `connectDevices`,
  `devicesToolkit` and the injected process/clock interfaces.
- `@ace/protocol/devices` exports schema-only `AppDevice`, `DeviceOperation`,
  inventory, state and message schemas. `AppDevice` avoids colliding with the
  existing paired-client `Device` model.
- `@ace/devices/client` exports a portable `DeviceClient` with an injected
  transport, request IDs and scheduler. It accepts JSON control messages and
  binary chunks, including fragmented relay packets.
  The React Devices tab owns the live view, gestures, lifecycle, logs and
  recording controls. `@ace/client` exposes `DeviceClient`, `deviceTransport`,
  `authenticatedChannel` and `downloadArtifact` for web and native hosts.

## Authorization and transport

An authenticated admin turns devices on. A device belongs to the thread whose agent or
person took it last: `sim_start` takes it for the agent's thread (booting it if needed) and
give that agent the controller lease with no prompt, unless a person controls it or another
agent holds an unexpired lease. A person can also hand it to one of a thread's agents.
Moving a device to another thread starts fresh logs and recordings. Input uses target
points, with `frame.scale` converting display pixels to those points. Control
expires after 30 seconds without an action. Queued actions retain their ticket until
completion. Agents can resume their expired lease on the next action; explicit
release and takeover invalidate it, and the agent takes it again with `sim_start`. Human takeover invalidates pending
agent commands, including commands awaiting SDK lookup or permission checks.
An already dispatched native command can finish; the next command must pass the
new ownership checks. Disconnect and credential revocation release control.

Local sockets use `devices.request`, `devices.result`, `devices.state` and
`devices.logs`. Frame packets use the existing screen binary format. Relay
clients open a dedicated channel with `hello.channel = "devices"`, then perform
the existing paired-client authentication. Browser and screen have dedicated
relay channels too. File downloads retain their existing channel and protocol.
Frames are fragmented into at most 64 KiB relay records and serialized as whole
packets so multiple streams cannot interleave. Reconnect requires fresh viewing requests;
it never replays input or grants control.

The daemon composes browser, screen and devices toolkits before provider sessions
start. Every adapter receives the same session-scoped MCP connection. Simulator
tools are named `sim_*` so they cannot be confused with paired machines: `sim_list`,
`sim_start`, `sim_stop`, `sim_ui` (tree or find), `sim_act` (ui, tap, long_press,
swipe, type, key, open_app, open_url, install, record_start, record_stop),
`sim_screenshot` and `sim_logs`. Each takes a `simId`.
Logs start on the first authorized `sim_logs` request and return a bounded
tail. Tools take no thread or agent override.

`sim_ui` puts short refs (`@e3`) on actionable elements only. `SimRefs` keeps one numbering per
agent and device, shared by MCP and the CLI: an element keeps its ref across reads while it
stays on screen, matched by the platform's own ref or else by role, name and frame. Every
`sim_act` on a ref re-reads the tree first; an element that has gone fails with `stale_ref`
before anything reaches the device. `tap`, `long_press` and `type` take a ref or a point.

`sim_screenshot` reads the live view when one runs, and otherwise takes a one-off still
(`simctl io screenshot`, or `screencap` pulled over adb), fitted inside the frame packet bounds.
The device how-to (`sim-guidance.ts`) rides on an agent's first `sim_start` of a device only.

`ace sim list|start|stop|ui|act|screenshot|logs --thread ID` is the same tools from a shell
(`sim-tools.ts` serves both). Like `ace task spawn`, it uses the local daemon credential and
acts as the named thread's root agent, so leases, takeover and refs are the MCP agent's own.

## SDKs and supported operations

Android SDK discovery checks `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
`~/Library/Android/sdk` and `~/Android/Sdk`, then resolves `platform-tools/adb`
and `emulator/emulator` by absolute path. adb need not be on PATH. iOS uses
`xcode-select -p` and requires full Xcode rather than Command Line Tools. Inventory
can still show one platform when the other SDK is missing; typed diagnostics
contain a fix hint. Physical devices are excluded.

Android capture speaks the scrcpy protocol (Apache-2.0) with ace's own client,
written from scrcpy's `doc/develop.md` and the documented message layouts. The
pinned upstream `scrcpy-server` v5.0.1 is downloaded on first use into
`<ACE_HOME>/tools` and checked against its SHA-256; `ACE_SCRCPY_SERVER` may name a
verified local copy. It is pushed with adb and started with `app_process` (video on,
audio off, control on) behind an `adb forward` tunnel. The emulator's own H.264 is
passed through to viewers with its parameter sets in front of every keyframe; a
keyframe request resets the device encoder; size, frame rate and bitrate come from
the shared stream profile. There is no time limit and no ffmpeg in the live view.
JPEG viewers, screenshots and recordings decode that H.264 once through ffmpeg;
without ffmpeg every viewer stays on H.264. Input goes over the control socket:
multi-touch with pointer ids (`pointer.pointerId`), keys including back, home and
recents, rotation, and text. Printable ASCII is injected as text; anything else
(accents, emoji) is pasted through the device clipboard and the action completes
when the device acknowledges it, so it replaces the emulator's clipboard. When the
server cannot start, capture falls back to `adb exec-out screenrecord` into ffmpeg
(JPEG, restarted at screenrecord's time limit, input through `adb shell input`).
`ACE_ANDROID_SCRCPY=off` forces that fallback.

Android UI trees come from ace's own long-running UiAutomation reader
(`src/android-ui-helper/`, a 4 KB dex built from `Main.java` with the SDK's javac
and d8: `bun run --filter @ace/devices build:android-ui-helper`). It is pushed and
started with `app_process`, answers each read over adb's stdio in tens of
milliseconds, and exits after 30 seconds idle so test runners can take UiAutomation.
If it cannot start or read the screen, `uiautomator dump` is used.
`ACE_ANDROID_UI_HELPER=off` disables it. Both run only when the daemon gives the
platform a tools directory.

iOS prefers a pinned `serve-sim` (0.1.47 or 0.1.48; install with
`npm install -g serve-sim@0.1.48`, or point `ACE_SERVE_SIM` at it). ace spawns
and supervises it per device: viewers that decode H.264 get its stream re-framed
as Annex B with no decode or re-encode, other viewers, screenshots and recordings
get its MJPEG through the bounded resize path, input uses its HID socket (edge
gestures included), and `ui.tree`/`ui.find`/`ui.act` read its accessibility
bridge. Other serve-sim versions are not driven (ADR 0064, "Native Simulator
transport"). Without it, iOS capture and semantic actions use the Simulator window
through the macOS helper. Set `ACE_SCREEN_HELPER` and grant Screen Recording and Accessibility
to **Ace Screen Helper** (the helper disclaims its launcher, so the grants belong
to its stable `dev.ace.screen-helper` identity). A missing permission fails with
`permission_denied` and a `permission` field naming it; `permissions` reads the
helper's state from a fresh process and `permissions.request` (human only) shows
macOS's prompt and opens the matching Privacy & Security pane on the daemon's
Mac. Capture finds the device's Simulator window even on another Space, and opens
Simulator in the background when the window is missing. Its name must match
uniquely, and no other booted Simulator may share that name. Simulator windows
belong to the Devices switch, so capture works with computer use off. Boot and
shutdown re-read the inventory, and
while a Devices view holds an `inventory.watch` lease the inventory is re-read every few seconds
and pushed as `devices.inventory`, so a device booted elsewhere shows up. Enabling or disabling
devices is pushed to every connection as `devices.enabled`. The screen manager currently owns one native capture,
so another computer/Simulator capture may need to stop first. Timed gestures use
the helper's target-point drag operation; direct platform calls without a window
binding can use detected idb.

Both platforms support boot/shutdown, app launch, URL/deep links, light/dark
appearance and location. iOS installs Simulator-built `.app` bundles; `.ipa`
receives an explicit unsupported error with an extraction/build hint. Android
installs `.apk` files. Runtime locale changes receive an unsupported error and a
Settings hint. The screenrecord fallback's `adb shell input` text accepts printable
ASCII and rejects Unicode and the special `%s` sequence rather than corrupting it,
and accepts one finger only. Android semantic
actions validate a fresh accessibility ref and disclose coordinate fallback.
iOS back/power keys are unsupported; home, rotate and enter use Simulator keys.

Recording requires `ACE_WORKSPACE_ROOT` so the daemon has a file artifact
registry, and ffmpeg for MP4 export. Raw recordings are capped at 512 MiB;
exported MP4 files retain a separate 50 MiB cap. Conversion
reads frame payloads individually, preserves their timing, and returns an
artifact ID and metadata. Clients stream the registered file through file
transfer rather than receiving video bytes in a JSON result.

## Bounds and verification

The service caps inventory at 1,024 entries, ownership records at 32, live
captures at four, queued inputs at 32 per device, and state subscribers at 64.
Each viewer retains one in-flight frame and one replaceable pending frame.
Frame payloads are capped at 8 MiB. UI dumps are capped at 1 MiB and trees at
512 nodes. Logs retain 256 lines of at most 4,096 characters, with a replaceable
64-line batch per blocked viewer and an explicit dropped count. Processes and
frame queues close on shutdown and revocation.

Behavior tests use fake installed executables and real local transport edges.
Native tests are opt-in. See [the manual plan](../../docs/testing/devices.md).
The current owner policy runs tests and benchmarks once at merge. None were
executed while implementing this feature. The non-gating benchmarks in `bench/`
report operations per second, microseconds per operation and peak RSS when that
policy permits execution. Native capture and encoding also need measurements
on the target machine.
