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

**Lengths:** a zod string bound counts code points in this repo (patched zod), while TypeScript's `.length` and `.slice()` count UTF-16 units. Match the unit of the TypeScript source, and test the boundary with an emoji. See rule 17 of `docs/engine/porting-guide.md`.

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
7. **Words come from the catalog.** Refusals and hints ("A person is controlling this device",
   "Only a person can do this", "Only a person can download device tools", `DeviceError` messages
   and next steps) live in `native/daemon/catalog/devices.json` (ADR 0225 safeguard 3), which the
   TypeScript and Rust both read; `check:catalog-text` compares what each backend renders with
   it. Never retype them.
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
(`media-paths.ts:158`–`:165`). With the switch on, the daemon starts scrcpy-server and its
`adb forward` as today and opens the ace-media source with origin `scrcpy {host: "127.0.0.1",
port}` (`media-wire/src/control.rs:130`). The startup handshake keeps today's order exactly
(`scrcpy-server.ts:175`–`:196`):

1. **ace-media connects the first socket and waits for the one dummy byte.** adb accepts a TCP
   connection even while nothing listens on the device and then closes it, so ace-media retries
   every 100 ms until a connection yields that byte, within the daemon's startup deadline
   (10 s by default, passed in the source's open), as `preamble(socket, 1, …)` does (`:178`–`:189`).
   Bytes read past the dummy byte are kept as the start of the metadata, never dropped.
2. **ace-media acknowledges `greeted` on the control wire right after the dummy byte**, before
   it reads anything else. Only the dummy byte arrives before control connects; the device name
   and codec follow once every socket is connected, so waiting for them first would deadlock.
3. **The daemon connects control** (the second connection of the tunnel, `:187`–`:189`) within
   the same startup deadline as the other steps, and tells ace-media `controlConnected`. Today's
   `open()` (`:68`–`:79`) has no timeout of its own; in Rust every step, the control connect
   included, is bounded by the one deadline, and a refused, reset or timed-out control connect
   fails the start with today's text and closes both sockets, the server and the forward
   (`close`, `:123`–`:130`).
4. **ace-media reads the rest**: the 64-byte device name (`deviceNameBytes`), then the u32 codec
   id and the 12-byte packet headers (`scrcpy-protocol.ts:217`), in a pure reader beside
   `serve_sim.rs`, and reports `ready {deviceName}` with the name as `JsString` (bytes up to the
   first NUL, decoded as UTF-8 like `toString("utf8")`), or a failure naming today's text
   ("scrcpy-server closed during startup", `:198`–`:203`).

**Video off (control first).** With `profile.video === false` the server greets the control
socket and there is no video socket (`scrcpy-server.ts:85`, `:187`–`:188`): D1 is not involved,
the daemon reads the dummy byte and the device name on control itself, as today, and its failure
cases (no greeting by the deadline, the server exiting, control closing during startup) keep
today's errors. With video on, the server exiting during any step (`exited`, `:156`–`:162`) fails
the start at once rather than at the deadline, on both sides.

Cancellation and reconnect cross two socket owners, so both sides follow one rule: whoever sees
an end first tells the other, and the capture ends once. A stop or abort in the daemon closes its
control socket and sends `close` for the source, and ace-media closes the video socket at once; a
video socket that ends or fails in ace-media ends its path (end marker, `interrupted`) and
reports it, and the daemon closes control and runs today's restart rule (`scrcpyRestartWorthIt`):
a restart opens a new server, tunnel and handshake under the same source, and video resumes at a
keyframe. A deadline that passes in step 1 or 4 fails the start with today's `DeviceError`
(`"scrcpy-server did not start…"`, `:181`–`:186`), and both owners close what they opened.

- (a): `scrcpy-capture.process`, `scrcpy-media.process`, `live-view.process`, `capture.process`,
  `platform.process`, `android-physical.process`, `emulator-window.process`; also with the switch
  on: `scrcpy-media-cleanup.process`, `scrcpy-host-capture.process`, `frame-encoder-media.process`.
- Also, switch on: cancel during each handshake step (before the dummy byte, between `greeted`
  and `controlConnected`, before `ready`), a control connect that is refused or never completes,
  the server exiting mid-handshake, the video-off profile, the video socket ending under a running capture, and a
  server restart, through `scrcpy-capture.process`, `scrcpy-media.process` and
  `scrcpy-media-cleanup.process`; nothing of either socket outlives the capture.
- (b) to move into ace-media: the video half of `scrcpy-protocol`, `scrcpy-video`.
- Measure `bench/frames.ts`; ask the owner for `bench/emulator-video.ts` (fps and stalls) both ways.

## D2: the inventory, pushed (needs E2)

Replaces the 4 s read (`inventory.ts:84`–`:94`; three SDK commands,
`android-platform.ts:104`–`:105` and `Simulators.list`) with triggers: `host:track-devices-l` on
the adb server (127.0.0.1:5037, started with `adb start-server` when absent); `notify` on the AVD
folder (`ANDROID_AVD_HOME`, else `~/.android/avd`) to re-run `emulator -list-avds`; `notify` on
the CoreSimulator device set to re-run `simctl list`, debounced. A trigger only starts a read; the
SDK read stays the answer. Nothing runs while no view holds the inventory (`holdInventoryView`,
`service.ts:301`). Until D3.1 has moved `Simulators`, D2 calls the TypeScript one through a port.

Watches die and miss events, so each source has a health state and the inventory never trusts a
silent one:

- **Reconcile on every (re)start.** Holding the view, a source starting, and every reconnect run
  one full read of all three lists, so anything missed while a source was down shows up.
- **Dead sources reconnect.** The adb track socket ending (adb server killed or restarted, a new
  SDK) reconnects with backoff (100 ms doubling to 5 s), then reconciles. A `notify` watcher that
  errors, a watched folder that is deleted or replaced (an AVD home created later, Xcode
  resetting the device set), or a platform rescan signal (`need_rescan`, FSEvents dropping
  events, inotify queue overflow) restarts the watch on the path or its nearest existing parent,
  then reconciles.
- **While any source is unhealthy, its list falls back to today's 4 s read** (only while viewed),
  and returns to triggers once the source is healthy and reconciled. A watch that can't start at
  all is unhealthy from the outset. The inventory the view sees is the same in every state.
- **A liveness reconcile, independent of watch health.** A watch can stay "healthy" and still go
  silent (a missed FSEvents batch, a track socket that stays open while adb stops reporting), so
  while a view holds the inventory one full reconcile read runs every 60 s whatever the sources
  report, and any difference it finds marks the source that should have reported it unhealthy
  (falling back to the 4 s read until it is restarted and reconciled). That is 3 SDK commands a
  minute instead of 45, and no silent source can hide a change for longer than a minute.
- **Bounded**: every read keeps its SDK byte cap and timeout; reconnects back off to 5 s and
  never run concurrently with themselves; at most one read per list is in flight.
- **Dropped triggers are harmless**: reads are debounced (250 ms) and coalesced, one read per list
  at a time, so a burst of events gives at most one extra read.

| TypeScript replaced (`packages/devices/src/`)      | Proof: (a) files                                                                                                                                                                                                                                                  | (b) cases to move                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `inventory`, `android-inventory`, `adb-transports` | `platform.process`, `android-physical.process`, `service.process`; daemon `devices-first-use.server.process`, `device-creation.server.process`; the same files on Linux and in the Windows VM (FSEvents, inotify and ReadDirectoryChangesW each fail differently) | `adb-transports`, the `InventoryWatch` cases of `audit` |

## D3: the platform (needs E2, D1)

Items land in order under one switch; each overrides its methods on `NativeDevicePlatform`.

| Item | TypeScript replaced (`packages/devices/src/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Proof: (a) files                                                                                                                                                                                                                                                                                                                           | (b) cases to move                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3.1 | `Simulators` (`@ace/screen`'s `simulator.ts`, also used by screen S2.2, which takes it from here), `platform` and `android-platform` lifecycle (list, boot, shutdown, install, open, configure), `commands`, `sdk`, `sdk-roots`, `android-tools`, `serve-sim-install`, `serve-sim-version`, `serve-sim-helpers`, `device-tools`, `tools-entry` (the download, check and unpack run as a task on the core's runtime, off the JS thread, instead of a separate Bun process), `emulator-args`, `emulator-discovery`, `lifecycle`, `action-budget` | `platform.process`, `android-physical.process`, `emulator-window.process`, `simulator-recovery.process`, screen `simulator.process`; `packages/diagnostics` tests that use `findAndroidTools`                                                                                                                                              | `android-sdk-install.process`, `device-tools.process`, `serve-sim-helpers.process`, `emulator-discovery.process`, `lifecycle`                                                                                                                                                                                                                                                                      |
| D3.2 | input and UI: `simulator-input`, `simulator-digitizer`, `simulator-fingers`, `simulator-ax`, `simulator-ui`, `simulator-screens`, `simulator-clipboard`, `simulator-posture`, `android-ui`, `android-ui-helper`, `android-input-shell`, `android-operations`, `android-posture`, `posture`, `scrcpy-input`, `scrcpy-clipboard`, `scrcpy-protocol` (control), `key-support`, `touch-support`, `clipboard`                                                                                                                                       | `simulator-touch.process`, `simulator-gestures.process`, `simulator-digitizer.process`, `simulator-clipboard.process`, `android-ui-helper.process`, `service-posture.process`, `pointer-moves`                                                                                                                                             | `android-input-shell.process`, `scrcpy-input`, `scrcpy-clipboard`, `simulator-fingers`, `simulator-ax`, `simulator-screens`, `simulator-posture`, `android-posture`, `posture`                                                                                                                                                                                                                     |
| D3.3 | captures and video paths: `capture`, `simulator-capture`, `simulator-avcc`, `simulator-frames`, `simulator-jpeg`, `simulator-transcode`, `simulator-source-rate`, `simulator-rotation`, `jpeg`, `mjpeg`, `scrcpy-server`, `scrcpy-capture`, `scrcpy-video`, `scrcpy-jar`, `frame-encoder`, `emulator-grpc`, `media-paths`, `host-frames`, `one-off-screenshot`, `still-writer`, `logs`, `log-line`, `recording`, `recording-limits`, `recording-artifact`                                                                                      | `capture.process`, `simulator-capture.process`, `simulator-h264.process`, `simulator-media.process`, `simulator-transcode-media.process`, `scrcpy-capture.process`, `scrcpy-media.process`, `live-view.process`, `recording-artifact.process`, `logs.process`, `service-logs.process`, `stream-control`, `stream-profile`, `media-vectors` | `device-video-status.process`, `frame-encoder-media.process`, `live-video-status`, `media-paths`, `media-want`, `scrcpy-host-capture.process`, `scrcpy-media-cleanup.process`, `scrcpy-jar.process`, `scrcpy-protocol`, `scrcpy-restart`, `simulator-avcc`, `simulator-frames`, `simulator-jpeg`, `simulator-stills.process`, `sim-serve-sim.process`, `simulator-transcode`, `one-off-screenshot` |
| D3.4 | chrome and skins: `device-chrome-reader`, `device-chrome-sources`, `simulator-chrome`, `simulator-chrome-files`, `simulator-body`, `simulator-body-png`, `simulator-panels`, `android-skin`, `android-skin-files`, `pdf-objects`, `pdf-svg`, `chrome-raster`, `device-images`; pixels through ace-media's image process (`image.job`, ADR 0208)                                                                                                                                                                                                | `service.process` (the `chrome` op), `client-screenshot`                                                                                                                                                                                                                                                                                   | `android-skin-files`, `chrome-raster`, `pdf-svg`, `simulator-body-png`, `simulator-chrome-files`                                                                                                                                                                                                                                                                                                   |

**The emulator's gRPC stream (D3.3)** replaces `streamScreen` (`emulator-grpc.ts:145`–`:198`)
with `hyper`'s HTTP/2 client and `prost` structs for the few fields it reads, keeping every detail
that the emulator checks or that keeps ace safe:

- cleartext HTTP/2 with prior knowledge to `http://127.0.0.1:<grpc port>` (no TLS, no upgrade);
  one POST to `screenshotPath` with `content-type: application/grpc`, `te: trailers` and
  `authorization: Bearer <token>`; the token is never logged;
- the request message as `screenshotRequest` builds it (`:38`–`:50`): RGBA8888, the box, and the
  MMAP transport whose handle is the frame file's URL exactly as `pathToFileURL(file).href` spells
  it (`file:///Users/…` on a Mac, `file:///C:/…` on Windows, the same percent-encoding); where a
  Rust URL builder spells a path differently, the URL is built by the TypeScript through a port,
  not approximated;
- gRPC framing checked before any decode: the compression flag must be 0 and the length at most
  `messageLimit`, refused otherwise (`GrpcMessages`, `:108`–`:124`); only then does `prost` decode;
  unknown fields are skipped, never fatal;
- `grpc-status` read from the response headers and from the trailers; any non-zero value refuses
  the stream with today's text; the stream ending on its own reports "Emulator screen stream
  ended"; `close()` ends it without a failure.

**Per-frame paths are not crossed (D3.3, measured 2026-11-25).** A decision made once per
capture, route or settings change runs in Rust through the addon (`native-video.ts`). A per-frame
or per-chunk decision does not: converting one scrcpy unit to the forwarded frame through the
addon measured a median 635,904 ns against the TypeScript's 457 ns for an 8 KiB unit (about
1,390x slower, JSON both ways), so the H.264 feed, the published frame, the Simulator frame and
JPEG per-picture decisions and the encoder note stay TypeScript, and the Rust remains the library
the all-Rust daemon calls directly (ADR 0226). Measure again if a per-frame crossing is ever
proposed; keep it only within about 5% of the TypeScript.

**Platform gates.** D3.1's `adb` and emulator paths and D3.3's gRPC stream (the frame file's URL
and MMAP mapping, HTTP/2 to a Windows emulator) pass in the Windows VM and on Linux before
default-on; macOS alone is not enough.

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
declares them (their descriptors are in MCP M1's catalog). Input is decided by the Zod port until this
item's typed decoding is pinned by the (a) files' rejection cases (ADR 0225 §4.2); model images
go through ace-media's image process.

- (a): `sim-tools.process`, `packages/mcp-server/src/sim-on-demand.process`, daemon
  `cli-sim.process`, `mcp-tools.process`, `mcp-tools-find.process`.

## Behaviour from main that every item keeps (2026-11-24)

Fixes landed on separate branches while this port was under way, each with its tests. The
TypeScript reaches the rewrite branch through its next merge of main. Whichever item ports the code
a fix touches keeps the fix's behaviour, and its tests become (a) files of that item:

- **Picture headers carry the source's coordinates** (`ace/fix-device-click-coordinates`,
  312c46b815). A device or screen picture header's `width / scale` is the source's coordinate
  width at every encode size. The client maps a click as `x = u * width / scale`
  (`packages/ui-core/src/devices.ts` `devicePoint`), and Simulator input normalises against
  serve-sim's native size (`packages/devices/src/simulator-input.ts`). Transcoded frames therefore
  keep `display_width` and `display_height` as the source picture's size, and the source's scale.
  The header scale is `source_scale * encoded_width / display_width` whenever display differs from
  width. Frames already labelled so that `display * scale == width` (the Mac screen helper's
  points) stay unchanged. Android scrcpy frames label display as the native display size. Browser
  headers are separate: they carry the page's CSS size (`ace/fix-browser-video-css-size`).
  Without this, clicks land at encoded/native of where the person clicked (56–68% on a 1206×2622
  Simulator). D1's scrcpy path and D3 carry it.
- **ace-media reopens every live source after its own restart**, with a watchdog for sources that
  open but never play (`ace/fix-media-restart-reopens-sources`). D1 and D3.
- **Loopback viewers get a fixed 16 Mbit/s link rate**, never the loss-based estimator
  (`ace/fix-local-viewer-link-rate`). D3 and S-items.
- **A view that stops acknowledging frames** (a hidden page) is parked rather than forcing source
  keyframes (`ace/fix-sim-tap-latency`). D3 and S-items.
- **serve-sim deltas carry the codec string** (`ace/fix-sim-delta-codec`). D3.
- **A picture header always names a codec** (`ace/fix-header-empty-codec`, 54f75c39d9). Producers
  send delta frames with an empty `codec_string` (serve-sim deltas, Android emulator frames
  re-encoded on the host), and the web and iOS clients reject a header whose codec isn't `jpeg`,
  `avc1.XXXXXX` or an hvc1/hev1 string. They then drop the media connection and reconnect every
  0.8 s or so. Delivery keeps each encode's last non-empty codec, and an empty codec never
  overwrites it. The header names the frame's own codec, or else the encode's recorded one. A
  codec-less frame for an encode with no recorded codec is not sent as a picture at all. Proof:
  ace-media `engine/tests/delivery.rs`
  `a_device_delta_that_names_no_codec_is_delivered_with_its_encodes_codec` and
  `a_delta_that_names_no_codec_before_its_encode_did_is_not_sent_as_a_picture`. D1, D3 and
  S-items.

## When you are done

- Every (a) file of your item passes alone with the switch on and off; your (b) cases pass in
  `cargo test -p ace-devices` (D1: in `native/media`); `check:daemon-native` (or `check:media`)
  passes; D4's cross-mode list passes both ways.
- Report: the files run and their results, the bench figures off and on, anything in
  behaviour.md that turned out wrong (with the code that shows it), anything you kept TypeScript
  because it couldn't be reproduced exactly, and the one test you added, if any, with the
  behaviour it covers that nothing did.

## Intended differences from the TypeScript

- **D4, a person's takeover during an agent's bind.** TypeScript's `claimForAgent` awaits its bind
  with `changingBinding` set, so the person's `controller` request is refused `devicesDisabled`;
  Rust lets the person's takeover through, reserves it, and the agent's claim loses.
- **D4, an agent resuming after a completed person's takeover.** TypeScript's `claimForAgent`
  checks the lease only before its bind, so an agent whose bind ends after the person took and
  finished can release the live human lease; Rust rechecks the bind's control revision after the
  cleanup before it assigns, so the person keeps control.
- **D4, a bind's reservation after a disable or a newer bind.** TypeScript's `finally` clears
  `changingBinding` from whichever bind finishes, including one already superseded, and keeps the
  reservation until then; Rust retires the reservation when devices are disabled or a newer bind
  starts, and an obsolete completion changes nothing.
- **D4, a takeover refused by a disable.** TypeScript runs the bind before it reserves control, so
  a refused bind leaves no marker; Rust reserves first, so it cancels its own assignment when the
  bind is refused and leaves any newer takeover alone.
- **D4, a person's bind reservation after a hand-back or a drop.** TypeScript keeps
  `changingBinding` until that bind's own cleanup finishes, even though the hand-back or disconnect
  invalidated the assignment, so an agent binding in between is refused `bindingBusy`; Rust retires
  the reservation the invalidated assignment left, and the person's stale continuation changes
  nothing.
- **D4, a takeover that loses control while it assigns.** TypeScript authorizes the requester once
  the input release resolves (`service.ts:861`), so the takeover answers whatever that check says
  by then; Rust answers `controlChanged` for the assignment whose revision or generation moved.
- **D4, a failed cleanup after a hand-back or a drop.** TypeScript's `bindDevice` throws its
  `AggregateError` before `assignController` runs, so the cleanup failure answers a hand-back or a
  drop that landed meanwhile; Rust answers `controlChanged` for the assignment whose revision moved
  while its cleanup failed, and lets the failure win only for a disable, which moves the generation.
