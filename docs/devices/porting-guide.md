# Porting devices to Rust

For the builders who move `@ace/devices` into `native/daemon` (`ace-devices`) and Android video
into ace-media, one work item each. Read
[ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §5 lists
every test file by class. The engine's [porting guide](../engine/porting-guide.md) sets the rules
for daemon crates; where this guide is silent, follow it.

Branch from `ace/daemon-rust-rewrite` once the item's needs (below) are merged, one branch per
item (`ace/rust-devices-<item>`).

## Rules for every item

1. **Same TypeScript interface.** You replace what sits behind `DevicePlatform`,
   `DevicesService`, `startCapture`, `devicesToolkit` and the bridge, never the interface:
   signatures, return shapes, `DeviceError` codes, timing (what is synchronous stays synchronous)
   and callback order are contract. `@ace/devices/client` (`DeviceClient`) is client code and is
   not ported.
2. **One switch, one line.** Each item's switch (ADR 0225 §6) is added to
   `packages/provider-kit/src/native-switches.ts` with its decision function and read by one `if`
   at the top of the constructor or factory you replace. With the switch on and the addon missing,
   fail; never fall back.
3. **Grow a facade method by method.** `NativeDevicePlatform extends DevicePlatform` and
   `NativeDevicesService` override the methods your item ports and inherit the rest, so items land
   one after another under one switch. A test's own subclass (`FakeSimPlatform`,
   `testing/fake-sim.ts:39`) keeps working: the Rust service drives any JavaScript platform
   through a `JsPlatform` bridge on the JS thread.
4. **No new tests.** The (a) files of your item are the proof; you don't edit them. One at a time,
   switch on and off, after checking the path (an empty path runs the whole suite):

   ```sh
   f=packages/devices/src/service.process.test.ts
   test -f "$f" && ACE_STORE=native ACE_DEVICES=native bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite, `bun run test`, `bun run check`, `test:process`, `test:slow` or
   `test:changed`. Never run a † file (behaviour.md §5) or `bench/emulator-video.ts`: they drive
   real simulators, emulators or phones, and the owner runs them.

5. **(b) cases move, they don't multiply**: into `#[cfg(test)]` beside the Rust function that
   replaces the TypeScript one, same inputs and expectations. Delete a TypeScript test only with
   its module, after default-on.
6. **Output through `ace-json`, strings as `JsString`** (ADR 0225 §1). `sim_*` results,
   `devices.*` messages, `DeviceState` and inventories serialize in their schema's key order; a
   UI tree a platform returned keeps its nodes' text exactly; device names, UDIDs, serials, bundle
   ids, AX labels and every line an SDK prints are `JsString`. Lengths and caps count UTF-16 units.
7. **Words are generated.** Refusals and hints ("A person is controlling this device", "Only a
   person can do this", "Only a person can download device tools", `DeviceError` messages and next
   steps) come from a table generated from the TypeScript (`scripts/generate-rust-devices-text.ts`,
   checked by `check:daemon-native`), never retyped.
8. **Same numbers**: 30 s lease, 4 s inventory read where a watch can't run, 60 fps, the stream
   profiles (`stream-profile.ts:34`), 64 KiB stream pieces, 8 MiB scrcpy packets, the ten-minute
   install budget, each SDK command's byte cap and timeout (`platform.ts:342`).
9. **Every child through `ace-supervisor`** (ADR 0223 E2): SDK commands, serve-sim, scrcpy-server,
   the digitizer, the Android UI helper, the `adb shell` for input, log streams.
10. **Rust rules**: no `unsafe`, no `unwrap`/`expect`, a `thiserror` enum, bindings only translate,
    injected clock, ids and spawner (engine porting guide rules 6, 7, 9).
11. **Build and check** in `native/daemon`:
    `PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH CARGO_BUILD_JOBS=4 cargo build --release -p ace-daemon-node`,
    then `bun run check:daemon-native`; D1 builds in `native/media` and runs `bun run check:media`.
12. **Measure** with `bun packages/devices/bench/sim-tools.ts` and `bench/frames.ts`, switch off
    and on, and report both.
13. **Commit and push as you go** with `git push origin HEAD:refs/heads/<your-branch>`; never
    rebase or force-push. Every commit ends with exactly `Co-Authored-By: spade <bot@acehq.dev>`.

## Files per item

| Item | Rust (yours)                                                                           | Binding (yours)                            | TypeScript shell (yours)                                     | Switch                        |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ | ----------------------------- |
| D1   | `native/media/crates/ace-media/src/scrcpy.rs`, `shell/readers.rs`, `engine/sources.rs` | none (ace-media's control wire)            | `packages/devices/src/scrcpy-capture.ts`, `scrcpy-server.ts` | `ACE_SCRCPY_VIDEO=media`      |
| D2   | `ace-devices/src/inventory/{mod,adb_track,watch}.rs`                                   | `ace-daemon-node/src/devices/inventory.rs` | `packages/devices/src/native-inventory.ts`                   | `ACE_DEVICE_INVENTORY=native` |
| D3.n | `ace-devices/src/platform/<area>.rs`                                                   | `ace-daemon-node/src/devices/platform.rs`  | `packages/devices/src/native-platform.ts`                    | `ACE_DEVICE_PLATFORM=native`  |
| D4   | `ace-devices/src/service/{mod,lease,cowork,sessions,refs,bridge,sim_tools}.rs`         | `ace-daemon-node/src/devices/service.rs`   | `packages/devices/src/native-service.ts`                     | `ACE_DEVICES=native`          |
| D5   | `ace-devices/src/tools.rs`                                                             | `ace-daemon-node/src/tools/devices.rs`     | the family line in `devicesToolkit` (`mcp.ts:37`)            | `ACE_NATIVE_TOOLS=devices`    |

## D1: ace-media reads scrcpy's video (needs nothing)

Today the daemon connects both of scrcpy-server's tunnel sockets (`scrcpy-server.ts:70`,
`:112`), reads video in JavaScript (`VideoStreamReader`, `scrcpy-protocol.ts:221`) and writes
each unit to ace-media's ingest (`scrcpy-capture.ts:185`–`:240`); egress brings it back
(`media-paths.ts:158`–`:165`). With the switch on: the daemon starts scrcpy-server and its
`adb forward` as today and opens the ace-media source with origin `scrcpy {host: "127.0.0.1",
port}` (`media-wire/src/control.rs:130`); ace-media connects first (the server greets its first
socket, the video one, `scrcpy-server.ts:85`), reads the preamble, codec id and 12-byte packet
headers (`scrcpy-protocol.ts:217`) in a pure reader beside `serve_sim.rs`, and reports it is
connected; the daemon then connects control and keeps it (input, clipboard, keyframes). Restarts
keep one source for the capture's life; video resumes at a keyframe.

- (a): `scrcpy-capture.process`, `scrcpy-media.process`, `live-view.process`, `capture.process`,
  `platform.process`, `android-physical.process`, `emulator-window.process`; also with the switch
  on: `scrcpy-media-cleanup.process`, `scrcpy-host-capture.process`, `frame-encoder-media.process`.
- (b) to move into ace-media: the video half of `scrcpy-protocol`, `scrcpy-video`.
- Measure `bench/frames.ts`; ask the owner for `bench/emulator-video.ts` (fps and stalls) both ways.

## D2: the inventory, pushed (needs E2)

Replaces the 4 s read (`inventory.ts:84`–`:94`; three SDK commands,
`android-platform.ts:104`–`:105` and `Simulators.list`) with triggers: `host:track-devices-l` on
the adb server (127.0.0.1:5037, started with `adb start-server` when absent, reconnecting with
backoff); `notify` on the AVD folder (`ANDROID_AVD_HOME`, else `~/.android/avd`) to re-run
`emulator -list-avds`; `notify` on the CoreSimulator device set to re-run `simctl list`, debounced.
A trigger only starts a read; the SDK read stays the answer. Nothing runs while no view holds the
inventory (`holdInventoryView`, `service.ts:301`). A watch that can't start falls back to today's
4 s read while viewed, and the state says nothing different.

| TypeScript replaced (`packages/devices/src/`)      | Proof: (a) files                                                                                                                               | (b) cases to move                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `inventory`, `android-inventory`, `adb-transports` | `platform.process`, `android-physical.process`, `service.process`; daemon `devices-first-use.server.process`, `device-creation.server.process` | `adb-transports`, the `InventoryWatch` cases of `audit` |

## D3: the platform (needs E2, D1)

Items land in order under one switch; each overrides its methods on `NativeDevicePlatform`.

| Item | TypeScript replaced (`packages/devices/src/`)                                                                                                                                                                                                                                                                                                                                                                                                             | Proof: (a) files                                                                                                                                                                                                                                                                                                                           | (b) cases to move                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3.1 | `platform` and `android-platform` lifecycle (list, boot, shutdown, install, open, configure), `commands`, `sdk`, `sdk-roots`, `android-tools`, `serve-sim-install`, `serve-sim-version`, `serve-sim-helpers`, `device-tools`, `tools-entry` (the download, check and unpack run as a task on the core's runtime, off the JS thread, instead of a separate Bun process), `emulator-args`, `emulator-discovery`, `lifecycle`, `action-budget`               | `platform.process`, `android-physical.process`, `emulator-window.process`, `simulator-recovery.process`; `packages/diagnostics` tests that use `findAndroidTools`                                                                                                                                                                          | `android-sdk-install.process`, `device-tools.process`, `serve-sim-helpers.process`, `emulator-discovery.process`, `lifecycle`                                                                                                                                                                                                                                                                      |
| D3.2 | input and UI: `simulator-input`, `simulator-digitizer`, `simulator-fingers`, `simulator-ax`, `simulator-ui`, `simulator-screens`, `simulator-clipboard`, `simulator-posture`, `android-ui`, `android-ui-helper`, `android-input-shell`, `android-operations`, `android-posture`, `posture`, `scrcpy-input`, `scrcpy-clipboard`, `scrcpy-protocol` (control), `key-support`, `touch-support`, `clipboard`                                                  | `simulator-touch.process`, `simulator-gestures.process`, `simulator-digitizer.process`, `simulator-clipboard.process`, `android-ui-helper.process`, `service-posture.process`, `pointer-moves`                                                                                                                                             | `android-input-shell.process`, `scrcpy-input`, `scrcpy-clipboard`, `simulator-fingers`, `simulator-ax`, `simulator-screens`, `simulator-posture`, `android-posture`, `posture`                                                                                                                                                                                                                     |
| D3.3 | captures and video paths: `capture`, `simulator-capture`, `simulator-avcc`, `simulator-frames`, `simulator-jpeg`, `simulator-transcode`, `simulator-source-rate`, `simulator-rotation`, `jpeg`, `mjpeg`, `scrcpy-server`, `scrcpy-capture`, `scrcpy-video`, `scrcpy-jar`, `frame-encoder`, `emulator-grpc`, `media-paths`, `host-frames`, `one-off-screenshot`, `still-writer`, `logs`, `log-line`, `recording`, `recording-limits`, `recording-artifact` | `capture.process`, `simulator-capture.process`, `simulator-h264.process`, `simulator-media.process`, `simulator-transcode-media.process`, `scrcpy-capture.process`, `scrcpy-media.process`, `live-view.process`, `recording-artifact.process`, `logs.process`, `service-logs.process`, `stream-control`, `stream-profile`, `media-vectors` | `device-video-status.process`, `frame-encoder-media.process`, `live-video-status`, `media-paths`, `media-want`, `scrcpy-host-capture.process`, `scrcpy-media-cleanup.process`, `scrcpy-jar.process`, `scrcpy-protocol`, `scrcpy-restart`, `simulator-avcc`, `simulator-frames`, `simulator-jpeg`, `simulator-stills.process`, `sim-serve-sim.process`, `simulator-transcode`, `one-off-screenshot` |
| D3.4 | chrome and skins: `device-chrome-reader`, `device-chrome-sources`, `simulator-chrome`, `simulator-chrome-files`, `simulator-body`, `simulator-body-png`, `simulator-panels`, `android-skin`, `android-skin-files`, `pdf-objects`, `pdf-svg`, `chrome-raster`, `device-images`; pixels through ace-media's image process (`image.job`, ADR 0208)                                                                                                           | `service.process` (the `chrome` op), `client-screenshot`                                                                                                                                                                                                                                                                                   | `android-skin-files`, `chrome-raster`, `pdf-svg`, `simulator-body-png`, `simulator-chrome-files`                                                                                                                                                                                                                                                                                                   |

Emulator gRPC uses `hyper`'s HTTP/2 client and `prost` with hand-written message structs for the
few fields `emulator-grpc.ts` reads; unknown fields are skipped, never fatal. Windows: D3.1's `adb`
and emulator paths pass in the Windows VM before default-on.

## D4: the service (needs D3, `ACE_STORE=native`)

| TypeScript replaced (`packages/devices/src/`)                                                                                                                                                                                                                                                                                                                                                                                                    | Proof: (a) files                                                                                                                                                                                                                                                                | (b) cases to move                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `service`, `actions`, `lease`, `lease-expiry`, `owner`, `binding`, `session`, `subscriptions`, `stream-control`, `stream-owners`, `device-queue`, `input-queue`, `input-budget`, `held-pushes`, `control-delivery`, `device-cowork`, `screen-controller`, `screen-failure`, `failure`, `sim-refs`, `sim-state`, `sim-activity`, `sim-act`, `sim-tools`, `sim-guidance`, `sim-schemas`, `bridge`, `device-tools-wire`, `devices-setting` (daemon) | `service.process`, `ownership`, `lease-expiry`, `device-cowork`, `bridge-welcome`, `sim-tools.process`; daemon `cli-sim.process`, `device-creation.server.process`, `devices-access.server.process`, `devices-first-use.server.process`, `devices-work`, `relay.device.process` | `audit` (the `SimulatorFrames` cases), daemon `devices-setting` |

Priority 1 (behaviour.md §3): an agent never acts on a device it doesn't hold; a person's takeover
invalidates every pending agent command, including those waiting on an SDK lookup or a permission
check; disconnect releases control. Port `ControllerLease` (`lease.ts:10`) rule for rule. Run the
cross-mode list (the daemon files above that restart) through `scripts/native-cross.ts` both ways.
`DeviceClient` tests (`client`, `client-media`, `client-media-generations`, `client-screenshot`)
are client code: run them once with the switch on to show the server side didn't change them. `client-screenshots` and `client` stay client code. `runtime`, `index`, `tools` and `mcp` are the shells.

## D5: the `sim_*` tools (needs D4, MCP M2)

The `devices` family's handlers: `sim_list`, `sim_start`, `sim_stop`, `sim_ui`, `sim_act`,
`sim_screenshot`, `sim_logs`. Registration, schemas, titles and risk classes stay as `mcp.ts`
declares them (MCP M1 generates their descriptors). Input is decided by the Zod port until this
item's typed decoding is pinned by the (a) files' rejection cases (ADR 0225 §4.2); model images
go through ace-media's image process.

- (a): `sim-tools.process`, `packages/mcp-server/src/sim-on-demand.process`, daemon
  `cli-sim.process`, `mcp-tools.process`, `mcp-tools-find.process`.

## When you are done

- Every (a) file of your item passes alone with the switch on and off; your (b) cases pass in
  `cargo test -p ace-devices` (D1: in `native/media`); `check:daemon-native` (or `check:media`)
  passes; D4's cross-mode list passes both ways.
- Report: the files run and their results, the bench figures off and on, anything in
  behaviour.md that turned out wrong (with the code that shows it), anything you kept TypeScript
  because it couldn't be reproduced exactly, and the one test you added, if any, with the
  behaviour it covers that nothing did.
