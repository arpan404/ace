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
  The React Devices tab owns the live view, gestures, approval, lifecycle, logs and
  recording controls. `@ace/client` exposes `DeviceClient`, `deviceTransport`,
  `authenticatedChannel` and `downloadArtifact` for web and native hosts.

## Authorization and transport

An authenticated admin enables devices and approves each device for a thread.
Only a human can grant a controller lease to a specific agent. Input uses target
points, with `frame.scale` converting display pixels to those points. Control
expires after 30 seconds without an action. Queued actions retain their ticket until
completion. Agents can resume their expired delegation on the next action; explicit
release, revocation and takeover invalidate it. Human takeover invalidates pending
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
start. Every adapter receives the same session-scoped MCP connection. Device
tools are `device_list`, `device_boot`, `device_open_app`, `device_open_url`,
`device_screenshot`, `device_ui_tree`, `device_find`, `device_act`, `device_tap`,
`device_swipe`, `device_type`, `device_key`, `device_logs`, `device_record_start`,
`device_record_stop` and `device_install`. A tap with `durationMs` is a long press.
Logs start on the first authorized `device_logs` request and return a bounded
tail. Tools take no thread or agent override. Agent screenshots require the
human-approved device stream to be live.

## SDKs and supported operations

Android SDK discovery checks `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
`~/Library/Android/sdk` and `~/Android/Sdk`, then resolves `platform-tools/adb`
and `emulator/emulator` by absolute path. adb need not be on PATH. iOS uses
`xcode-select -p` and requires full Xcode rather than Command Line Tools. Inventory
can still show one platform when the other SDK is missing; typed diagnostics
contain a fix hint. Physical devices are excluded.

Android capture pipes `adb exec-out screenrecord --output-format=h264` into
ffmpeg. The pipe applies backpressure before decoding; independent JPEG frames
can then skip intermediate images safely. ffmpeg must be on the daemon's PATH.
Identical decoded images are suppressed and the finite screenrecord process
restarts at its native boundary. Actual image compatibility, latency and CPU
cost require live verification at merge. No emulator gRPC endpoint is assumed.

iOS capture and semantic actions use the approved Simulator window through the
macOS helper. Set `ACE_SCREEN_HELPER` and grant Screen Recording and Accessibility
to **Ace Screen Helper** (the helper disclaims its launcher, so the grants belong
to its stable `dev.ace.screen-helper` identity). A missing permission fails with
`permission_denied` and a `permission` field naming it; `permissions` reads the
helper's state from a fresh process and `permissions.request` (human only) shows
macOS's prompt and opens the matching Privacy & Security pane on the daemon's
Mac. Capture finds the device's Simulator window even on another Space, and opens
Simulator in the background when the window is missing. Its name must match
uniquely, and no other booted Simulator may share that name. A person starting a
live view approves the Simulator window for capture; agents still need the
device approved for their thread. Boot and shutdown re-read the inventory, and
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
Settings hint. Android CLI text input accepts printable ASCII and rejects
Unicode and the special `%s` sequence rather than corrupting it. Android semantic
actions validate a fresh accessibility ref and disclose coordinate fallback.
iOS back/power keys are unsupported; home, rotate and enter use Simulator keys.

Recording requires `ACE_WORKSPACE_ROOT` so the daemon has a file artifact
registry, and ffmpeg for MP4 export. A recording is capped at 50 MiB. Conversion
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
