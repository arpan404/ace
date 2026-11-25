# In-app devices: observable behaviour and invariants

The contract of `@ace/devices` (iOS Simulators, Android emulators and phones) that any
reimplementation must keep. It is written for builders, against the code on
`ace/daemon-rust-rewrite` at 42386d3751. [ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md)
decides what moves to Rust; [porting-guide.md](porting-guide.md) says how. The product contract
is [ADR 0064](../adr/0064-in-app-devices.md), [ADR 0104](../adr/0104-browser-tab-device-ownership.md),
[ADR 0115](../adr/0115-one-device-one-machine.md), [ADR 0143](../adr/0143-cowork-computer-use.md)
and, for pictures, [ADR 0147](../adr/0147-ace-media-rust-media-pipeline.md) and
[ADR 0208](../adr/0208-ace-media-is-the-only-media-and-image-pipeline.md). The package README
(`packages/devices/README.md`) describes the wire and tools in prose.

## 1. What it is and where its work runs

- **A control plane in the daemon process.** 18,462 source lines in 124 modules
  (`packages/devices/src`), loaded on first use (`apps/daemon/src/lazy-devices.ts`), started by the
  service registry (`apps/daemon/src/services/devices.ts`).
- **It moves no pixels itself.** Since ADR 0208 no TypeScript decodes or encodes an image.
  ace-media (Rust, `native/media`, its own processes) encodes, delivers, records and makes stills.
  serve-sim (npm, pinned by `serve-sim-version.ts`) produces a Simulator's H.264; on Android,
  scrcpy-server on the device or the screen helper's host encoder (`frame-encoder.ts`) does.
- **What it does run:** short-lived SDK commands (`xcrun simctl`, `xcrun devicectl`, `plutil`,
  `adb`, `emulator`), each through `@ace/provider-kit`'s supervisor (`DeviceRuntime.spawn`,
  `runtime.ts:14`); long-lived helpers per watched device (serve-sim, the screen helper in
  digitizer mode for touches, `simulator-digitizer.ts:117`; the Android UI helper,
  `android-ui-helper.ts:50`; an `adb shell` for input, `android-input-shell.ts:24`; scrcpy-server,
  `scrcpy-server.ts:132`; a log stream, `logs.ts:36`); emulator gRPC over HTTP (`emulator-grpc.ts`).
- **Video passes through the daemon's JavaScript as bytes, never as pixels.** On iOS, ace-media
  reads serve-sim's stream itself (`simulator-capture.ts:100`), and its egress brings every unit
  back to the daemon (`media-paths.ts:158`–`:165`) for the capture's own consumers. On Android the
  daemon owns scrcpy's sockets and forwards each unit to ace-media's ingest
  (`scrcpy-capture.ts:185`–`:187`), so each unit crosses JavaScript twice.

## 2. Public surface

`package.json` exports `.`, `./tools`, `./client`, `./stream-profile`, `./sdk-roots`,
`./android-tools` and `./testing`. Callers outside the package use these 22 names (production /
test call sites counted over `apps/`, `packages/`, `tools/`, `scripts/`):

| Export                            | Defined at                        | Callers outside (prod / test) | Example callers                                                                                                             |
| --------------------------------- | --------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Actor`                           | `src/lease.ts:2`                  | 1 / 0                         | `apps/daemon/src/lazy-devices.ts:1`                                                                                         |
| `DeviceChromeReader`              | `src/device-chrome-reader.ts:26`  | 1 / 0                         | `apps/ios/scripts/spike-devices.ts:18`                                                                                      |
| `DevicePlatform`                  | `src/platform.ts:93`              | 1 / 8                         | `apps/daemon/bench/device-relay.ts:13`                                                                                      |
| `DevicesOptions`                  | `src/service.ts:45`               | 0 / 1                         | tests only                                                                                                                  |
| `DevicesService`                  | `src/service.ts:60`               | 5 / 9                         | `apps/daemon/bench/device-relay.ts:13`, `apps/daemon/src/machines/target-devices.ts:4`, `apps/daemon/src/lazy-devices.ts:1` |
| `agentOwner`                      | `src/owner.ts:2`                  | 0 / 1                         | tests only                                                                                                                  |
| `deviceChromeSources`             | `src/device-chrome-sources.ts:55` | 1 / 0                         | `apps/ios/scripts/spike-devices.ts:18`                                                                                      |
| `devicesToolkit`                  | `src/mcp.ts:37`                   | 0 / 2                         | tests only                                                                                                                  |
| `/android-tools findAndroidTools` | `src/android-tools.ts:19`         | 2 / 0                         | `packages/diagnostics/src/linux-host.ts:4`, `packages/diagnostics/src/toolchains.ts:1`                                      |
| `/client DeviceClient`            | `src/client.ts:99`                | 0 / 3                         | tests only                                                                                                                  |
| `/client DeviceClientError`       | `src/client.ts:53`                | 1 / 0                         | `packages/client/src/device-transport.ts:12`                                                                                |
| `/client DeviceTransport`         | `src/client.ts:43`                | 2 / 1                         | `packages/client/src/device-transport.ts:12`, `packages/client/src/device-route.ts:2`                                       |
| `/client DeviceTransportEvents`   | `src/client.ts:35`                | 0 / 1                         | tests only                                                                                                                  |
| `/testing fakeNode`               | `src/testing/fake-sim.ts:22`      | 0 / 2                         | tests only                                                                                                                  |
| `/testing fakeSimService`         | `src/testing/fake-sim.ts:144`     | 0 / 2                         | tests only                                                                                                                  |
| `/tools ServeSimStatus`           | `src/serve-sim-version.ts:54`     | 1 / 0                         | `apps/daemon/src/toolchains.ts:3`                                                                                           |
| `/tools agentOwner`               | `src/owner.ts:2`                  | 2 / 0                         | `apps/daemon/src/machines/guest-sessions.ts:13`, `apps/daemon/src/services/cli-sim.ts:1`                                    |
| `/tools deviceControlDelivery`    | `src/control-delivery.ts:4`       | 1 / 0                         | `apps/daemon/src/services/devices.ts:2`                                                                                     |
| `/tools devicesToolkit`           | `src/mcp.ts:37`                   | 2 / 0                         | `apps/daemon/src/machines/target-devices.ts:5`, `apps/daemon/src/services/mcp.ts:23`                                        |
| `/tools managedServeSim`          | `src/serve-sim-install.ts:61`     | 1 / 0                         | `apps/daemon/src/toolchains.ts:3`                                                                                           |
| `/tools pinnedServeSim`           | `src/serve-sim-version.ts:13`     | 1 / 0                         | `apps/daemon/src/toolchains.ts:3`                                                                                           |
| `/tools serveSimStatus`           | `src/serve-sim-version.ts:67`     | 1 / 0                         | `apps/daemon/src/toolchains.ts:3`                                                                                           |

The rest of the contract is reached through those names:

- `DevicesService` (`service.ts:60`): `request(op, actor)` (`:393`) takes every `DeviceOperation`
  of `@ace/protocol/devices` (`protocol/src/devices.ts:196`–`:284`: `enable`, `list`, `states`,
  `inventory.watch`, `permissions`, `permissions.request`, `tools.install`, `chrome`, `boot`,
  `shutdown`, `install`, `open_app`, `open_url`, `configure`, `start`, `stop`, `stream.configure`,
  `stream.keyframe`, `subscribe`, `unsubscribe`, `controller`, `input`, `posture`, `screenshot`,
  `clipboard.get`, `clipboard.set`, `ui.tree`, `ui.find`, `ui.act`, `logs.start`, `logs.stop`,
  `logs`, `record.start`, `record.stop`); `claimForAgent` (`:252`), `ownsControl` (`:278`),
  `screenshot` (`:845`), `subscribe`/`subscribeEvery` (`:938`, `:954`), `subscribeLogs` (`:1022`),
  `watch`/`watchEnabled`/`watchInventory` (`:285`, `:319`, `:332`), `holdInventoryView` (`:301`),
  `disconnect(owner)` (`:1043`), `close` (`:1072`).
- `devicesToolkit` (`mcp.ts:37`) registers the agent tools `sim_list`, `sim_start`, `sim_stop`,
  `sim_ui`, `sim_act`, `sim_screenshot`, `sim_logs` on an `@ace/mcp-server` `ToolRegistry`;
  `sim-tools.ts` serves the same calls to `ace sim … --thread` (`apps/daemon/src/services/cli-sim.ts`).
- `connectDevices` / `reserveDevices` (`bridge.ts:75`, `:85`) speak `devices.request`, `devices.result`,
  `devices.state`, `devices.logs` and the `deviceFrame` stream kind to a client socket.
- `DeviceClient` (`client.ts:99`) is the portable client the web and native apps use through
  `@ace/client` (`packages/client/src/device-transport.ts:12`).

## 3. Behaviour that is contract

### Ownership and leases (priority 1: an agent never acts on a device it doesn't hold)

- A device belongs to the thread whose agent or person took it last (`boundThread`,
  `service.ts:244`). `sim_start` takes it for the calling agent's thread and boots it if needed,
  with no prompt, unless a person controls it or another agent holds an unexpired lease
  (`claimForAgent`, `service.ts:252`–`:276`: "A person is controlling this device").
- `ControllerLease` (`lease.ts:10`): a claim lasts 30 s from the last action (`lease.ts:23`);
  each claim bumps an epoch. A queued action keeps its ticket (`ticket`, `:69`) until it
  completes; `assert(actor, epoch)` (`:73`) refuses an action whose epoch has passed. An agent may
  resume its own expired lease on its next action (`resume`, `:89`); explicit release and
  takeover invalidate it.
- A person's takeover invalidates every pending agent command, including those still waiting on
  SDK lookup or a permission check. A command already dispatched to the native side may finish;
  the next one passes the new ownership check. `actor.guard` re-checks the caller's lifetime at
  each asynchronous boundary (`lease.ts:8`, `service.ts:411`).
- Disconnect and credential revocation release control (`disconnect`, `service.ts:1043`).
  Reconnecting never replays input or grants control; a view must subscribe again.
- Moving a device to another thread starts fresh logs and recordings.
- Cowork (ADR 0143, on by default): the person's input from a view goes in while an agent holds
  the device, and the agent's input waits while the person is using it (`service.ts:370`–`:376`).

### Person-only operations

`enable`, `controller`, `stream.configure` and `stream.keyframe` refuse an agent with
`permission_denied` "Only a person can do this" (`service.ts:412`–`:419`); `tools.install`
("Only a person can download device tools", `:462`) and `permissions.request` ("Human
authorization required", `:758`) likewise. These are ace's own person-only actions, not
approvals: ace never adds a gate to a provider's permission decision (the agent's tool calls are
governed by its provider's permission mode, through the tools' MCP annotations).

### Agent tools

- Tools take a `simId` and no thread or agent override; the caller comes from the MCP
  credential.
- `sim_ui` gives short refs (`@e3`) to actionable elements only; `SimRefs` keeps one numbering per
  agent and device, shared by MCP and the CLI; a ref survives reads while its element stays on
  screen, matched by the platform's own ref, else by role, name and frame. Every `sim_act` on a
  ref reads the tree again first, and a vanished element fails with `stale_ref` before anything
  reaches the device.
- `sim_screenshot` reads the live view when one runs, else takes a one-off still (`simctl io
screenshot`, or `screencap` over adb), fitted inside the frame bounds by ace-media.
- The device how-to (`sim-guidance.ts`) rides on an agent's first `sim_start` of a device only.
- Errors are `DeviceError` (`sdk.ts`) codes mapped to `PublicToolError` text: model-facing
  strings are contract, byte for byte.

### Live views and pictures

- H.264 only, 60 fps on every connection (`deviceStreamProfile`, `stream-profile.ts:34`: local
  12 Mbit/s, remote 8 Mbit/s in 1440×2880, relay 5 Mbit/s in 1080×2160). Pressure lowers bit rate
  to 1 Mbit/s and at worst shrinks remote and relay pictures to three quarters; it never lowers
  the frame rate. No live view receives a JPEG; a capture that can only make JPEG refuses the view
  with a typed error naming the fix.
- Pictures are cut into stream pieces of at most 64 KiB and each picture is written whole.
  A screenshot is a still on the same stream, sent just before the `devices.result` naming it.

### Inventory

- Read every 4 s (`inventoryIntervalMs`, `service.ts:90`) only while a view holds the inventory
  (`holdInventoryView`, `service.ts:301`; `inventory.ts:84`); nothing polls otherwise.
- Each read runs `xcrun simctl list` (through `Simulators`, `@ace/screen`), `emulator -list-avds`
  and `adb devices -l` (`android-platform.ts:104`–`:105`). An emulator's AVD name and a phone's
  hardware are read once per serial and cached (`android-platform.ts:121`–`:133`).
- Intended difference under `ACE_DEVICE_INVENTORY=native` (D2): ADB reconnect reconciles and 60 s
  liveness reconciles clear the cached per-serial emulator AVD names and hardware before reading
  (`coordinator.rs` `invalidate_adb_cache`, `android-platform.ts` `invalidateIdentityCache`), so an
  emulator serial reused by a different AVD across an ADB restart (such as `emulator-5554`) reports
  the new device id instead of keeping the pre-restart name.
- Intended difference under `ACE_DEVICE_INVENTORY=native` (D2): `AndroidPlatform.boot()` serializes
  its console-port `adb devices -l` scan through `DevicesService`'s single-flight inventory guard
  (`android-platform.ts` `boot`, `service.ts` `guardedAndroidList`), so an emulator boot does not
  run `adb devices -l` concurrently with an in-flight native reconcile.

### Timeouts, cancellation and lenient decoding

- Every SDK command has a byte cap and a timeout (`platform.ts:342`); installs get the
  ten-minute device install budget (`deviceInstallTimeoutMs`, `action-budget.ts:1`). `maxToolTimeoutMs` (660 s,
  `mcp-server/src/timeouts.ts:2`) covers the install plus transport grace.
- Cancelling a capture stops everything it started, including a startup still waiting on
  serve-sim (`simulator-capture.ts:105`–`:111`).
- Device and SDK output is parsed with schemas at the boundary (`commands.ts`, `sdk.ts`); an
  unknown inventory entry is skipped, never fatal.

## 4. Measured (2026-11-23, M4 Max, load average 50 to 140)

Through the real `DevicesService` and `devicesToolkit` over `FakeSimPlatform`
(`testing/fake-sim.ts`), 300 calls each, CPU of the calling process per call: `sim_list` 78 µs,
`sim_ui` of a 120-node tree 636 µs (p50 0.24 ms, result 18 KB), `sim_act` on a ref 474 µs (it
re-reads the tree), `sim_act` at a point 51 µs, `sim_screenshot` 28 µs. Existing
`bench/frames.ts`: latest-frame replacement to 32 viewers 0.27 µs, 128 KiB picture stream
assembly 4.18 µs, 128 KiB fragmented JPEG framing 4.68 µs. A supervised spawn of
`/usr/bin/true` costs the daemon 1.25 ms of CPU (0.28 ms for a bare `spawnSync`), before the
SDK command's own run time. At 60 fps and 12 Mbit/s a watched device moves about 1.5 MB/s
through JavaScript as Buffers (twice on Android), about 0.5 ms of CPU per second at the framing
cost above. Nothing here was measured against a real Simulator or device.

## 5. The tests that guard this, and which carry over

- **(a)** behaviour through the public surface (`DevicesService`, `devicesToolkit`, `DeviceClient`,
  the bridge, `@ace/devices/testing`), with fake SDK commands or the fake platform. Must pass
  unchanged on any reimplementation behind its switch.
- **(b)** a test of a module that is not a package export: what it guards, and that its cases move
  beside the Rust function that replaces it, if one ever does.
- **(c)** redundant: none found with confidence.
- **live** (marked †): drives a real Simulator, emulator or phone (`*.live.process`,
  `*.native.process`). Never run by builders; the owner runs them.

### (a): 40 files

`android-physical.process`, `android-ui-helper.process`, `bridge-welcome`, `capture.process`, `client-media-generations`, `client-media`, `client-screenshot`, `client`, `device-cowork`, `device.live.process` †, `emulator-window.process`, `lease-expiry`, `live-view.process`, `logs.process`, `media-vectors`, `one-off-screenshot.process` †, `ownership`, `platform.process`, `pointer-moves`, `recording-artifact.process`, `scrcpy-capture.process`, `scrcpy-media.process`, `scrcpy.live.process` †, `service-logs.process`, `service-posture.process`, `service.process`, `sim-tools.process`, `simulator-capture.process`, `simulator-clipboard.process`, `simulator-digitizer.process`, `simulator-gestures.native.process` †, `simulator-gestures.process`, `simulator-h264.process`, `simulator-media-live.process` †, `simulator-media.process`, `simulator-recovery.process`, `simulator-touch.process`, `simulator-transcode-media.process`, `stream-control`, `stream-profile`.

`service.process` imports `deviceImageStream` (`stream-control.ts`) only to build its expected stream; it tests through `DevicesService`. Files marked † are live.

### (b): 40 files

| File                           | Internal it reaches (module.export)                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adb-transports`               | adb-transports.adbTransports adb-transports.physicalIdPart                                                                                                                                                                                                   |
| `android-input-shell.process`  | android-input-shell.AndroidInputShell commands.androidInput                                                                                                                                                                                                  |
| `android-posture`              | android-posture.EmulatorPostures android-posture.EmulatorConsole                                                                                                                                                                                             |
| `android-sdk-install.process`  | sdk.resolveXcode                                                                                                                                                                                                                                             |
| `android-skin-files`           | device-chrome-sources.readSmallFile android-skin-files.readAndroidSkin android-skin-files.AndroidSkinSource                                                                                                                                                  |
| `audit`                        | simulator-frames.SimulatorFrames inventory.InventoryWatch                                                                                                                                                                                                    |
| `chrome-raster`                | chrome-raster.chromeAsPng device-chrome-sources.svgPng                                                                                                                                                                                                       |
| `device-tools.process`         | device-tools.downloadDeviceTools serve-sim-install.NpmArtifact                                                                                                                                                                                               |
| `device-video-status.process`  | media-paths.DeviceMedia simulator-capture.simulatorCapture                                                                                                                                                                                                   |
| `emulator-discovery.process`   | emulator-discovery.emulatorConsolePort emulator-discovery.emulatorGrpc emulator-args.emulatorBootArgs                                                                                                                                                        |
| `frame-encoder-media.process`  | frame-encoder.startFrameEncoder media-paths.DeviceVideoPaths                                                                                                                                                                                                 |
| `lifecycle`                    | lifecycle.stopDevice session.createSession                                                                                                                                                                                                                   |
| `live-video-status`            | media-paths.DeviceMedia                                                                                                                                                                                                                                      |
| `media-paths`                  | media-paths.DeviceVideoPaths media-paths.Switched scrcpy-video.VideoUnit                                                                                                                                                                                     |
| `media-want`                   | media-paths.withMediaWant                                                                                                                                                                                                                                    |
| `one-off-screenshot`           | one-off-screenshot.shotJpeg                                                                                                                                                                                                                                  |
| `pdf-svg`                      | pdf-svg.pdfArt pdf-svg.svgDocument                                                                                                                                                                                                                           |
| `posture`                      | posture.readPosture                                                                                                                                                                                                                                          |
| `scrcpy-clipboard`             | scrcpy-clipboard.clipboardReplyMs scrcpy-clipboard.clipboardSettleMs scrcpy-clipboard.ScrcpyClipboard scrcpy-protocol.ControlMessage                                                                                                                         |
| `scrcpy-host-capture.process`  | scrcpy-capture.scrcpyCapture                                                                                                                                                                                                                                 |
| `scrcpy-input`                 | scrcpy-input.HeldPointers scrcpy-input.scrcpyInputPlan                                                                                                                                                                                                       |
| `scrcpy-jar.process`           | scrcpy-jar.scrcpyServerJar                                                                                                                                                                                                                                   |
| `scrcpy-media-cleanup.process` | media-paths.DeviceMedia                                                                                                                                                                                                                                      |
| `scrcpy-protocol`              | scrcpy-protocol.DeviceMessageReader scrcpy-protocol.VideoStreamReader scrcpy-protocol.encodeControl scrcpy-protocol.scrcpyMaxSize scrcpy-protocol.scrcpyServerArgs scrcpy-protocol.scrcpySocketName scrcpy-protocol.DeviceMessage scrcpy-protocol.VideoEvent |
| `scrcpy-restart`               | scrcpy-capture.scrcpyRestartWorthIt                                                                                                                                                                                                                          |
| `scrcpy-video`                 | scrcpy-video.ScrcpyVideoUnits scrcpy-video.VideoUnit                                                                                                                                                                                                         |
| `serve-sim-helpers.process`    | serve-sim-helpers.replaceOutdatedHelper                                                                                                                                                                                                                      |
| `sim-serve-sim.process`        | simulator-capture.simulatorCapture                                                                                                                                                                                                                           |
| `simulator-avcc`               | simulator-avcc.AvccRecords simulator-avcc.annexB simulator-avcc.avcConfig simulator-avcc.AvccRecord                                                                                                                                                          |
| `simulator-ax`                 | simulator-ax.simulatorActionInput simulator-ax.simulatorTarget simulator-ax.simulatorTree                                                                                                                                                                    |
| `simulator-body-png`           | pdf-svg.pdfArt simulator-body-png.pngBody simulator-body.bodyLayout                                                                                                                                                                                          |
| `simulator-chrome-files`       | device-chrome-sources.readSmallFile simulator-chrome-files.readSimulatorChrome simulator-chrome-files.SimulatorChromeSource                                                                                                                                  |
| `simulator-fingers`            | simulator-fingers.fingerDown simulator-fingers.fingerMove simulator-fingers.fingerUp simulator-fingers.noFingers                                                                                                                                             |
| `simulator-frames`             | simulator-frames.SimulatorFrames simulator-frames.StillTooLarge                                                                                                                                                                                              |
| `simulator-jpeg`               | simulator-jpeg.SimulatorJpeg stream-control.deviceStillStream                                                                                                                                                                                                |
| `simulator-live.process` †     | simulator-capture.simulatorCapture                                                                                                                                                                                                                           |
| `simulator-posture`            | simulator-posture.SimulatorPostures simulator-posture.PostureCommand                                                                                                                                                                                         |
| `simulator-screens`            | simulator-screens.readSimulatorScreens simulator-screens.touchTarget                                                                                                                                                                                         |
| `simulator-stills.process`     | simulator-capture.simulatorCapture                                                                                                                                                                                                                           |
| `simulator-transcode`          | simulator-transcode.simulatorEncodeSpec                                                                                                                                                                                                                      |

### In the daemon (`apps/daemon/src/`, 7 files)

| Test files                                                                                                                                                       | Class | What it guards                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli-sim.process`, `device-creation.server.process`, `devices-access.server.process`, `devices-first-use.server.process`, `devices-work`, `relay.device.process` | a     | `ace sim`, socket and relay access, first use and admin enable, through a started daemon (`relay.device.process` also reads `devices.ts`' relay channel) |
| `devices-setting`                                                                                                                                                | b     | `devices-setting.ts` and `lazy-devices.ts`: the stored switch and lazy start                                                                             |

Counts: 46 (a) files (5 of them live), 41 (b) (1 live), 0 (c).

## 6. Intended differences in the Rust port

The Rust platform is held to §3, with these deliberate differences, each proven in Rust:

- **A value the schemas reject is a typed `DeviceError`, not a raw `ZodError`.** Today
  `DevicePlatform.install` (`platform.ts:528`), `openApp` (`:554`) and `openUrl` (`:595`) parse the
  path, app id and URL with Zod inside the operation, so a relative path, a malformed app id or a
  URL without a scheme surfaces as a `ZodError` that carries no `DeviceFailure` code. With
  `ACE_DEVICE_PLATFORM=native` the same input is refused as `invalid_data`, with a message and a
  hint, before any SDK command runs (`ace-devices/src/platform/lifecycle.rs`). The device surface
  is `DeviceFailure`, so callers gain the code they needed to branch on; nothing is accepted that
  the schemas rejected.
- **A physical Android device's location is decided before appearance is applied.** Today
  `configure` (`platform.ts:623`–`:635`) sets night mode and only then refuses the location on a
  phone, leaving the appearance changed on a request that failed. The Rust platform decides the
  whole request first (`lifecycle::configure`), so a refused configuration changes nothing.
- **An unreadable `wm size` override refuses the read instead of falling back to the physical
  size.** `androidDimensions` (`commands.ts:115`–`:129`) takes `override ?? physical`, so a
  malformed override line fails the read (as a `ZodError`) rather than reporting the physical
  size; `ace-devices`' `commands::android_dimensions` keeps that outcome and returns it as
  `invalid_data` with today's message and hint.

## 7. D3.1 review fixes (2026-11-25)

The platform's review found TypeScript behaviours the Rust side had drifted from. They are fixed
in `ace-devices` only, and today's TypeScript is left as it was (owner rule):

- **Windows SDK roots follow `path.win32`.** A drive-rooted `C:\sdk`, `C:/sdk`, `\sdk` or a UNC
  share is absolute on a Windows host even when the checking build host is macOS
  (`platform/sdk.rs`, `is_absolute`).
- **`xcode-select -p` keeps the 4,096-unit schema cap and a null exit code.** A probe that
  answered with `code: null` is a failed selection, not a probe that never ran; only a probe that
  threw is "Xcode developer directory is unavailable" (`sdk::xcode_selection`,
  `sdk::xcode_probe_failure`).
- **A resolved Android activity is still an app id.** The component `resolve-activity` prints
  must fit 256 UTF-16 units, as `AppId` requires (`lifecycle::open_app`).
- **Emulator discovery stops at the first match.** The shell reads discovery files in order and
  asks `emulator::grpc_file` about each, so it never opens a FIFO or an unreadable sibling after
  the emulator's own file matched.
- **Every D3.1 path reaches Rust.** `DevicePlatform.list`, `boot`, `shutdown` and the tools
  download plan are `ace-devices` decisions; Android capture takes `wm size` from
  `commands::android_dimensions`, so the documented `sizeUndecoded` refusal is reachable.
- **A listed Simulator's name stays a JavaScript string.** The listed entry crosses the binding
  as JSON text and the record's name is a `JsString`, so a lone surrogate the SDK printed is
  listed and returned in the same UTF-16 units (`platform/list.rs`).

## 8. D3.1 round-3 review fixes (2026-11-25)

The recheck found five more places the port had drifted. Each is fixed test-first, in Rust or in
the shell that wires it, and the TypeScript that stays is the switch-off path unchanged.

- **The boot wait's program is one raw argument.** `adb shell` takes the readiness loop as a
  single unquoted argument, as TS passes it; `adb_shell`'s single-quoting made the device read
  the whole loop as a command name (`boot::android_boot`).
- **Downloads and unpacking run on the native runtime.** `serve-sim-install`, `serve-sim-version`,
  `serve-sim-helpers`, `tools-entry` and `Simulators`' parse are `ace-devices` decisions:
  `serve_sim::install` fetches the pinned tarballs over the native HTTP client, checks the
  registry's sha512 (and scrcpy's sha256), enforces the same 32 MiB and release-size limits,
  writes the same `.serve-sim-<id>.partial` staging directory and renames it into place atomically;
  `serve_sim::managed`, `version`, `supported` and `replaces_helper` answer the lookup and helper
  questions; `simulators::list` parses `simctl list devices --json` with the schema's caps and
  keeps names as `JsString`.
- **A Simulator's listed state and the 240 s budget decide its boot.** The native boot asks the
  plan about the inventory's entry, not the caller's possibly stale record, and gives
  `boot`/`bootstatus` the base's 240 s.
- **The switch-off leg is unchanged.** The Android boot refuses a missing emulator before the
  window and `adb devices` probes on both legs, exactly as the base did. No command probe takes
  the platform's injected clock on either leg: the native platform's Xcode adapter runs
  `xcode-select -p` through `run`, which keeps today's timers, so `resolveXcode`'s own scheduler
  applies only when it is called directly, not through the platform (which it never is). The
  posture helper keeps its injected clock on the native platform, where a compressed test clock
  cannot stand in for a command's own deadline.
- **The catalog check reads both backends.** `check:devices-catalog` fails when a device source
  spells a catalog message or hint itself (generic hint phrases excepted), and every device word
  `platform-base.ts`, `commands.ts` and `android-platform.ts` raise now comes from `catalog.ts`.

## 9. D3.1 round-4 review fixes (2026-11-25)

- **`ACE_SCRCPY_SERVER` crosses explicitly.** The install request carries the setting the shell
  read, so a verified override is used without a request and a wrong one keeps the TypeScript's
  refusal (`serve_sim::install`, `device-tools.ts`).
- **Staging and deadlines match the shell.** The staging directory is named with the id the
  shell gives, directories are created 0700 and files 0600, and a timed-out install checks a
  cancellation flag immediately before its rename, so a late unpack never publishes; its partial
  file and staging directory are removed.
- **D2's scoped reads survive D3.** `Platform.scopedListing()` lets the native facade keep
  `listSource` re-reading only the triggered source, with the peer's cached outcome.
- **The install client trusts the operating system's store.** `rustls` + `rustls-native-certs`
  replace reqwest's platform verifier, whose `webpki-root-certs` dependency is CDLA-Permissive-2.0
  and outside ace's licence allowlist; `cargo deny check bans licenses sources` passes.
- **The catalog owns the tool words.** The download hints and the timeout text live in
  `catalog/devices.json`'s `tools` section, which both backends read; the check compares them and
  fails on a source that spells one.

## 10. D3.1 round-5 review fixes (2026-11-25)

- **The install client survives a bad system root and follows the shell's proxies.** Parsable
  certificates are added one by one and only an empty store refuses; `HTTPS_PROXY`/`HTTP_PROXY`
  and `NO_PROXY` are honoured, with HTTPS tunnelled through `CONNECT` as Bun's fetch does.
- **Its reads are bounded and its chunk framing is counted separately.** A head line is capped as
  it is read, a chunk-size line never counts toward the header cap, and an HTTPS redirect that
  would downgrade to HTTP is refused.
- **An empty `ACE_SCRCPY_SERVER` is unset**, in the shell and in Rust, so a verified downloaded
  copy is reused rather than refused.
- **The keychain is read off the async thread, inside the install deadline**, and a timed-out
  install still cannot publish its staging copy.
- **The catalog check reads Rust too**, and the tool words are resolved once per install: a
  missing key is an error, never an empty hint.

## 11. D3.1 round-6 review fixes (2026-11-25)

- **Chunk framing cannot overflow or size an allocation from the wire.** A chunk larger than the
  remaining byte budget is refused with `size > limit - len`, and its body is read through a fixed
  buffer; a chunk that does not end in CRLF is refused.
- **Framing follows HTTP/1.1.** Differing duplicate `Content-Length` values are refused, and the
  only accepted transfer coding is `chunked` alone (no decoder exists for another).
- **Proxies follow Bun's documented rule** (bun.com/docs/runtime/networking/fetch.md, "Proxying
  requests"): `HTTP_PROXY` for http, `HTTPS_PROXY` for https, either case, `ALL_PROXY` when the
  scheme's variable is unset, `no_proxy` before `NO_PROXY`, comma or whitespace entries including
  `host:443` and IPv6 forms. Credentials in the proxy URL are percent-decoded into a Basic
  `Proxy-Authorization` on CONNECT and on absolute-form requests, and never logged. A variable
  that cannot be parsed is an install error, an https proxy is refused with a clear error, and a
  socks value is ignored as Bun ignores one.
- **Redirects stay on HTTP(S).** Only http and https are followed on every hop, and an HTTPS
  response never downgrades to HTTP.
- **IPv6 literal hosts work.** SNI and the TLS name use the bare address, while `Host` and
  `CONNECT` use the bracketed form, and a `no_proxy` entry of `::1` is a host, not a port.
- **A `#[cfg(test)]` item is blanked, not the rest of its file.** The catalog check's Rust scan
  resumes after the item, with a unit test for brace-laden test bodies.

## 12. D3.2: input and UI (2026-11-25, revised after round 2)

`ACE_DEVICE_PLATFORM=native` answers these decisions from `ace-devices`; the switch-off leg is
today's TypeScript unchanged, byte for byte. "Wired" means the TypeScript shell calls the addon
on every path a proof file or the platform takes; "shell" is what still runs in TypeScript around
the decision (a process, a promise, a cache).

| TypeScript                                        | Rust                                                         | Wired                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `scrcpy-protocol` (control)                       | `platform/scrcpy/protocol.rs` (frames, reader, server args)  | control frames through `encodeControl`                                       |
| `scrcpy-input`                                    | `platform/scrcpy/input.rs` (plan, held pointers)             | the plan; `HeldPointers` is the capture's (D3.3)                             |
| `scrcpy-clipboard`                                | `platform/scrcpy/clipboard.rs` (request ordering, deadlines) | shell is `scrcpy-capture` (D3.3)                                             |
| `key-support`, `touch-support`                    | `platform/keys.rs`                                           | yes                                                                          |
| `clipboard`                                       | `platform/clipboard.rs`                                      | bounds and the Android refusal                                               |
| `simulator-fingers`                               | `platform/fingers.rs` (held fingers, edges)                  | yes, every step                                                              |
| `simulator-digitizer`                             | `platform/fingers.rs` (`digitizer_step`)                     | yes, every touch line                                                        |
| `simulator-input`                                 | `platform/fingers.rs` (`key_action`, points, typing args)    | keys, points, edges, typing arguments; the process is the shell              |
| `simulator-screens`                               | `platform/screens.rs`                                        | yes                                                                          |
| `posture`, `simulator-posture`, `android-posture` | `platform/posture.rs`                                        | the report reads and the fold decisions; the per-device caches are the shell |
| `simulator-ax`                                    | `platform/simulator_ax.rs`                                   | tree, layout, target, action input                                           |
| `android-ui`                                      | `platform/android_ui.rs`                                     | tree, find, target, action                                                   |
| `android-operations`                              | `platform/android_ui.rs` (`act`), `platform/helper.rs`       | the action decision; the read queue is the shell                             |
| `android-ui-helper`                               | `platform/helper.rs` (args, line protocol, budgets)          | arguments, READY/answer lines, the answer's body                             |
| `android-input-shell`                             | `platform/helper.rs` (pinned args, marker line, queue bound) | arguments, marker, line and answer                                           |
| `simulator-clipboard`                             | `platform/clipboard.rs` (`pasteboard_plan`)                  | the command, byte cap and deadline                                           |
| `simulator-ui`                                    | words only (catalog)                                         | the `/ax` read is D3.3's capture                                             |

Deferred to D3.3, with its reason: `scrcpy-capture` owns the control socket, so `HeldPointers`,
the `ScrcpyClipboard` instance and `SimulatorInput`'s epochs are instantiated there;
`simulator-capture` owns the `/ax` fetch (`simulator-ui`'s budget and timeout). Their decisions
are in Rust with their tests, and D3.3 wires them when it moves the capture.

The (b) cases moved beside those functions: `scrcpy-input` (13), `scrcpy-clipboard` (6, one for
one), `simulator-fingers` (4), `simulator-screens` (3), `simulator-ax` (8), `simulator-posture`
(6), `android-posture` (3), `posture` (5), and `android-input-shell.process`'s pinned-shell case.
Seven Rust tests beyond those guard behaviour no moved case covers, and only that: a clipboard
read asked for after an idle stretch still waits its full reply window, and a paste's timeout
names the paste (the two round-2 regressions); the digitizer step, the HID key messages (rotate,
keyboard, Return) and the third-finger refusal (`simulator-fingers` has no case for them);
`posture_from_hinge`'s line rule and `screen_count`'s raw count (no TS case). The round-2
divergences have their own cases: a node's value and find fallback (Android and Simulator),
unusable children, a lone-surrogate label, `js_round`, control text and a non-object scroll.
`platform/keys.rs`, `platform/clipboard.rs`, `platform/android_ui.rs` and `platform/helper.rs`
have no TypeScript test file of their own (behaviour.md §5 lists none), so their Rust tests are
the only guard: keys (5), clipboard (3), Android UI (8), the Android helper and input shell (4).

Intended differences, each proven in Rust:

- **A Simulator point outside the frame is a typed `invalid_data`.** `SimulatorInput` throws a
  plain `Error` there; the Rust decision returns the `DeviceFailure` shape, so a caller can branch
  on it. Nothing accepted changes.
- **A ref is hashed from `ace-json`'s identity text.** `simulator-ax` and `android-ui` hash
  `JSON.stringify(identity)`; the Rust hashes the same JSON written by `ace-json`, which is
  identical for every string a device can produce (a lone surrogate included).

Round-2 review fixes, in Rust only (today's TypeScript stays as it was):

- **A node's value is optional.** Android always has one (`""` when the node has no text) and a
  Simulator node has one only when serve-sim reported an `AXValue`, so a text find reads
  `value ?? name` exactly as today (`platform/android_ui.rs:22`).
- **Unusable children leave the element with none.** `null`, a non-array or more than 4,096
  children no longer drop the element or its subtree (`platform/simulator_ax.rs:102`).
- **A clipboard deadline counts from its own request**, and an unanswered paste says
  `pasteTimedOut` (`platform/scrcpy/clipboard.rs:128`).
- **Control text is UTF-8 from its UTF-16 units**: a lone surrogate becomes U+FFFD and a literal
  U+E000 is one character, as `Buffer.from` writes them (`platform/scrcpy/protocol.rs:191`).
- **AX labels are `JsString`**, so a lone surrogate the SDK printed survives.
- **A Simulator key refuses with its own words** (`androidActionKey`, `watchSideKey`) and Return
  types a newline (`platform/scrcpy/input.rs`, `platform/fingers.rs`).
- **Hinge and screen reads follow today's regex and list**: any `hinge-angle0` that carries an
  angle, and the report's own display count (`platform/posture.rs`).
- **The schema still validates options and scroll values**: the TypeScript parses them with Zod
  before the native call, and Rust refuses a non-object scroll value too.
