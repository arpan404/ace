# Screens and computer use: observable behaviour and invariants

The contract of `@ace/screen`: the person's live view and takeover of Mac, Windows and Linux
windows and Simulators, and agent computer use. Written against `ace/daemon-rust-rewrite` at
42386d3751. [ADR 0225](../adr/0225-device-screen-automation-and-mcp-control-planes-stay-typescript.md)
decides what moves to Rust; [porting-guide.md](porting-guide.md) says how. Product contract:
[ADR 0011](../adr/0011-screen-and-computer-use.md), [0048](../adr/0048-windows-screen-helper.md),
[0049](../adr/0049-linux-screen-helper.md), [0067](../adr/0067-background-computer-use.md),
[0069](../adr/0069-screen-daemon-dispatch.md), [0087](../adr/0087-background-computer-use-engine.md),
[0142](../adr/0142-a-bots-computer.md), [0143](../adr/0143-cowork-computer-use.md), and for
pictures [0147](../adr/0147-ace-media-rust-media-pipeline.md) and
[0208](../adr/0208-ace-media-is-the-only-media-and-image-pipeline.md). `packages/screen/README.md`
describes the helper wire in prose.

## 1. What it is and where its work runs

- **An orchestration layer in the daemon process**: 14,516 source lines in 98 modules
  (`packages/screen/src`), started by `apps/daemon/src/services/screen.ts`.
- **The native helpers do the work.** `ace-screen-helper` (Swift, `native/screen-helper`) on
  macOS, `ace-screen-helper-linux` and `ace-screen-helper-windows` (Rust) capture, encode
  (H.264, HEVC on a Mac whose trial worked), read accessibility trees, settle the UI and post
  input. ace-media takes every session's video (`media-source.ts:24`–`:32`): the helper writes to
  ace-media's ingest, and ace-media's egress hands units back to the daemon only for its own
  consumers (`media-source.ts:171`–`:176`). The privileged locked-use service is its own native
  process (`native/locked-use`).
- **Two halves:**
  1. **Sessions** (`ScreenManager`, `manager.ts:51`): the person's live view, takeover,
     Simulators (`simulator.ts`), recordings, the v1/v2 helper wire (`helper.ts`, `frames.ts`),
     measurement, and the session tools that remain agent tools on Windows (`screenToolkit`,
     `mcp.ts:75`).
  2. **Agent computer use** (`computerToolkit`, `computer/toolkit.ts:119`, over `ComputerClient`,
     `computer/client.ts:96`): `screen_apps`, `screen_state`, `screen_act`, `screen_display`,
     with `ScreenCowork` (`cowork.ts:48`) and locked use (`locked-use-*.ts`, `lockedUseGate`,
     `computer/locked-use-gate.ts:109`).

## 2. Public surface

`package.json` exports `.`, `./testing/locked-use-host`, `./testing/locked-use-service` and
`./testing/support`. Callers outside the package use these 62 names:

| Export                                     | Defined at                            | Callers outside (prod / test) | Example callers                                                                                                                     |
| ------------------------------------------ | ------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CapturedPicture`                          | `src/frame-picture.ts:5`              | 1 / 0                         | `packages/devices/src/still-writer.ts:3`                                                                                            |
| `ComputerClient`                           | `src/computer/client.ts:96`           | 5 / 3                         | `apps/daemon/bench/tool-list.ts:7`, `apps/daemon/src/machines/target-screen.ts:3`, `apps/daemon/src/computer-tools.ts:3`            |
| `ComputerClientOptions`                    | `src/computer/client.ts:20`           | 1 / 0                         | `apps/daemon/src/services/screen.ts:3`                                                                                              |
| `ComputerError`                            | `src/computer/errors.ts:2`            | 0 / 1                         | tests only                                                                                                                          |
| `ComputerMachineRoute`                     | `src/computer/toolkit.ts:75`          | 1 / 0                         | `apps/daemon/src/computer-tools.ts:3`                                                                                               |
| `ComputerPlatform`                         | `src/computer/schemas.ts:9`           | 1 / 0                         | `apps/daemon/src/computer-tools.ts:3`                                                                                               |
| `Frame`                                    | `src/frames.ts:11`                    | 7 / 17                        | `packages/devices/src/one-off-screenshot.ts:5`, `packages/devices/src/capture.ts:4`, `packages/devices/src/simulator-capture.ts:2`  |
| `FrameHub`                                 | `src/frames.ts:132`                   | 2 / 0                         | `packages/devices/bench/frames.ts:1`, `packages/devices/src/session.ts:2`                                                           |
| `FrameSink`                                | `src/frames.ts:130`                   | 1 / 0                         | `packages/devices/src/service.ts:9`                                                                                                 |
| `Helper`                                   | `src/helper.ts:68`                    | 0 / 2                         | tests only                                                                                                                          |
| `HelperOptions`                            | `src/helper.ts:39`                    | 0 / 1                         | tests only                                                                                                                          |
| `LockedUseAttemptError`                    | `src/locked-use-attempt.ts:15`        | 1 / 0                         | `apps/daemon/src/locked-use-runtime.ts:17`                                                                                          |
| `LockedUseConnection`                      | `src/locked-use-connection.ts:79`     | 1 / 0                         | `apps/daemon/src/locked-use-runtime.ts:17`                                                                                          |
| `LockedUseGate`                            | `src/computer/locked-use-gate.ts:73`  | 1 / 0                         | `apps/daemon/src/computer-locked-use.ts:7`                                                                                          |
| `LockedUseInstaller`                       | `src/locked-use.ts:12`                | 3 / 1                         | `apps/daemon/src/locked-use-state.ts:2`, `apps/daemon/src/services/registry.ts:37`, `apps/daemon/src/locked-use-installer.ts:1`     |
| `LockedUseServiceStatus`                   | `src/locked-use-wire.ts:81`           | 1 / 0                         | `apps/daemon/src/locked-use-runtime.ts:17`                                                                                          |
| `LockedUseTurnScope`                       | `src/computer/locked-use-gate.ts:31`  | 1 / 0                         | `apps/daemon/src/locked-use-runtime.ts:17`                                                                                          |
| `MacHost`                                  | `src/locked-use-host.ts:15`           | 1 / 0                         | `apps/daemon/src/locked-use-installer.ts:1`                                                                                         |
| `PrivilegedRunner`                         | `src/locked-use-mac.ts:15`            | 2 / 0                         | `apps/daemon/src/locked-use-privileged.ts:2`, `apps/daemon/src/locked-use-installer.ts:1`                                           |
| `Scheduler`                                | `src/runtime.ts:12`                   | 2 / 0                         | `apps/daemon/src/locked-use-runtime.ts:17`, `apps/daemon/src/locked-use-in-flight.ts:6`                                             |
| `ScreenCowork`                             | `src/cowork.ts:48`                    | 2 / 1                         | `apps/daemon/src/services/spade-computers.ts:6`, `apps/daemon/src/services/screen.ts:3`                                             |
| `ScreenCoworkOptions`                      | `src/cowork.ts:18`                    | 1 / 0                         | `apps/daemon/src/services/screen.ts:3`                                                                                              |
| `ScreenManager`                            | `src/manager.ts:51`                   | 12 / 20                       | `apps/daemon/bench/tool-list.ts:7`, `apps/daemon/src/evals/world.ts:12`, `apps/daemon/src/tool-result-mcp.ts:13`                    |
| `ScreenStopError`                          | `src/stop-error.ts:2`                 | 1 / 0                         | `packages/devices/src/capture.ts:4`                                                                                                 |
| `Simulator`                                | `src/simulator.ts:12`                 | 1 / 0                         | `packages/devices/src/commands.ts:8`                                                                                                |
| `Simulators`                               | `src/simulator.ts:13`                 | 4 / 1                         | `apps/daemon/src/services/relay-channel.ts:6`, `apps/daemon/src/services/registry.ts:37`, `apps/daemon/src/services/screen.ts:3`    |
| `StreamOwners`                             | `src/stream-owners.ts:44`             | 1 / 0                         | `packages/devices/src/stream-control.ts:4`                                                                                          |
| `commonStream`                             | `src/stream-owners.ts:14`             | 1 / 0                         | `packages/devices/src/stream-control.ts:4`                                                                                          |
| `computerToolNames`                        | `src/computer/schemas.ts:89`          | 2 / 0                         | `apps/daemon/src/external-mcp/server.ts:12`, `apps/daemon/src/services/mcp.ts:26`                                                   |
| `computerToolkit`                          | `src/computer/toolkit.ts:119`         | 2 / 3                         | `apps/daemon/bench/tool-list.ts:7`, `apps/daemon/src/computer-tools.ts:3`                                                           |
| `computerUseTools`                         | `src/tools.ts:15`                     | 0 / 2                         | tests only                                                                                                                          |
| `connectLockedUse`                         | `src/locked-use-connection.ts:303`    | 1 / 0                         | `apps/daemon/src/locked-use-runtime.ts:17`                                                                                          |
| `deviceWindowBundles`                      | `src/device-input-policy.ts:7`        | 1 / 0                         | `packages/devices/src/capture.ts:4`                                                                                                 |
| `framePacket`                              | `src/frames.ts:26`                    | 4 / 9                         | `packages/devices/bench/frames.ts:1`, `packages/devices/src/one-off-screenshot.ts:5`, `packages/devices/src/simulator-capture.ts:2` |
| `framePicture`                             | `src/frame-picture.ts:27`             | 2 / 0                         | `packages/devices/bench/frames.ts:6`, `packages/devices/src/bridge.ts:11`                                                           |
| `graphicalSessionEnvironment`              | `src/linux-session.ts:105`            | 2 / 0                         | `apps/daemon/src/doctor/computer-use-linux-facts.ts:2`, `apps/daemon/src/services/screen.ts:3`                                      |
| `installScreenHelper`                      | `src/install.ts:74`                   | 2 / 1                         | `apps/daemon/src/services/devices.ts:5`, `apps/daemon/src/services/screen.ts:3`                                                     |
| `linuxComputerEnvironment`                 | `src/computer/session.ts:8`           | 1 / 0                         | `apps/daemon/src/services/screen.ts:3`                                                                                              |
| `localScreenManager`                       | `src/host.ts:14`                      | 1 / 0                         | `apps/daemon/src/services/screen.ts:3`                                                                                              |
| `lockedUseGate`                            | `src/computer/locked-use-gate.ts:109` | 1 / 0                         | `apps/daemon/src/computer-locked-use.ts:7`                                                                                          |
| `macHost`                                  | `src/locked-use-host.ts:72`           | 1 / 0                         | `apps/daemon/src/locked-use-installer.ts:1`                                                                                         |
| `macLockedUseInstaller`                    | `src/locked-use-mac.ts:61`            | 1 / 0                         | `apps/daemon/src/locked-use-installer.ts:1`                                                                                         |
| `macPhysicalInput`                         | `src/computer/physical-input.ts:34`   | 1 / 0                         | `apps/daemon/src/services/screen.ts:3`                                                                                              |
| `perAction`                                | `src/tool-schemas.ts:39`              | 1 / 0                         | `packages/devices/src/sim-schemas.ts:9`                                                                                             |
| `placeholderLockedUseInstaller`            | `src/locked-use.ts:31`                | 2 / 0                         | `apps/daemon/src/services/registry.ts:37`, `apps/daemon/src/locked-use-installer.ts:1`                                              |
| `runProtectedAttempt`                      | `src/locked-use-attempt.ts:137`       | 1 / 0                         | `apps/daemon/src/locked-use-runtime.ts:17`                                                                                          |
| `sameStream`                               | `src/stream-owners.ts:24`             | 1 / 0                         | `packages/devices/src/stream-control.ts:4`                                                                                          |
| `screenConnection`                         | `src/bridge.ts:51`                    | 2 / 1                         | `apps/daemon/src/services/relay-channel.ts:6`, `apps/daemon/src/services/screen.ts:3`                                               |
| `screenTargetApps`                         | `src/index.ts:103`                    | 1 / 0                         | `apps/daemon/src/computer-tools.ts:3`                                                                                               |
| `screenToolkit`                            | `src/mcp.ts:75`                       | 1 / 2                         | `apps/daemon/src/services/mcp.ts:26`                                                                                                |
| `uiReadRequest`                            | `src/tool-schemas.ts:131`             | 1 / 0                         | `packages/devices/src/sim-tools.ts:13`                                                                                              |
| `uiReadShape`                              | `src/tool-schemas.ts:115`             | 1 / 0                         | `packages/devices/src/sim-schemas.ts:9`                                                                                             |
| `wantedStreamSettings`                     | `src/media-source.ts:81`              | 1 / 0                         | `packages/devices/src/media-paths.ts:16`                                                                                            |
| `windowsPhysicalInput`                     | `src/computer/physical-input.ts:58`   | 1 / 0                         | `apps/daemon/src/services/screen.ts:3`                                                                                              |
| `/testing/locked-use-host emptyLayout`     | `src/locked-use-fake-mac.ts:97`       | 0 / 1                         | tests only                                                                                                                          |
| `/testing/locked-use-host fakeMac`         | `src/locked-use-fake-mac.ts:111`      | 0 / 1                         | tests only                                                                                                                          |
| `/testing/locked-use-host fakeTeam`        | `src/locked-use-fake-mac.ts:24`       | 0 / 1                         | tests only                                                                                                                          |
| `/testing/locked-use-host installedLayout` | `src/locked-use-fake-mac.ts:83`       | 0 / 1                         | tests only                                                                                                                          |
| `/testing/support fakeScreenMedia`         | `src/testing/support.ts:123`          | 0 / 1                         | tests only                                                                                                                          |
| `/testing/support macHostPlatform`         | `src/testing/support.ts:23`           | 0 / 1                         | tests only                                                                                                                          |
| `/testing/support manager`                 | `src/testing/support.ts:24`           | 0 / 1                         | tests only                                                                                                                          |
| `/testing/support ready`                   | `src/testing/support.ts:45`           | 0 / 1                         | tests only                                                                                                                          |

`@ace/devices` is the largest internal caller: it reuses `Frame`, `framePacket`, `FrameHub`,
`StreamOwners`, `Simulators`, `perAction`, `uiReadShape` and `wantedStreamSettings`.

## 3. Behaviour that is contract

### Computer use (macOS and Linux; the session tools on Windows)

- **One helper per target app**, at most six (`maxHelpers`, `computer/client.ts:229`), the least
  recently used idle one evicted; an idle helper exits after five minutes (`:221`); one shared
  helper answers `hello`, `apps`, `resolve` and the display ops. Different apps run in parallel;
  a hung app stalls only its own helper. Helpers start on first use and restart after they exit.
- **Wire**: JSON lines; requests `{id, op, …}` with `op` in `hello`, `apps`, `resolve`, `state`,
  `act`, `cancel {target}`; replies `{id, ok: true, result}` or `{id, ok: false, error: {code,
message}}`, the message written for the model. Replies decode leniently (`computer/wire.ts`).
  Each helper runs one request at a time and answers `cancel` at once.
- **Cancellation and deadlines**: `act` 85 s, `state` 40 s, others 15 s
  (`defaultDeadlineMs`, `computer/client.ts:80`). An aborted or overdue call sends `cancel`, waits
  a 3 s grace for the reply (`graceMs`, `:183`; an act reports the steps it finished), then kills
  only that app's helper. A reply over 32 MiB fails its call at once (`maxReplyBytes`, `:181`).
- **Outline and diff**: an observation waits for the UI to settle and returns one line per
  meaningful element with stable ids; the toolkit keeps each caller's last outline per app and
  returns the diff, or exactly "No change since your last look." (`computer/outline.ts`, pure).
- **Screenshots** are window-only, at most 1568 px on the long edge and about 1.15 MP, so model
  pixels are the helper's pixels; actionable elements are tagged with their ids.
- **The person wins** (priority 1): an action refuses while the person is using that same app;
  Esc during agent activity stops it; a locked screen is reported; cowork (`ScreenCowork`) makes
  the agent wait while the person uses the app (`yield`, `cowork.ts:97`).
- **Refused apps**: password managers, authentication prompts, terminals, script runners
  (Script Editor, Automator, Shortcuts), ace itself, and the apps the person lists under
  `computer.blockedApps`, by name or bundle id, case-insensitively (`blockedReason`,
  `computer/policy.ts:245`). They are refused before the helper opens or touches them.
- **Permissions are provider-native.** There are no per-app grants and ace adds no approval:
  an agent's call is decided by its provider's permission mode from the tools' MCP annotations.
  Turning computer use on is the person's (an authenticated admin).
- **Locked use** (macOS, opt-in): the protected attempt (`runProtectedAttempt`,
  `locked-use-attempt.ts`) unlocks, acts and relocks within its ready (15 s) and relock (30 s)
  timeouts (`locked-use-attempt.ts:236`, `:284`); the gate (`lockedUseGate`) decides per turn.
  The service's status is read every 60 s (`locked-use-mac.ts:63`).

### Sessions (live view and takeover)

- Capture is off by default; an authenticated admin turns it on; the switch persists in SQLite.
  Controller leases never survive a restart.
- Up to eight macOS app/window sessions share one helper, one exclusive lease per bundle id.
  A takeover epoch is checked on the first action after a takeover.
- Every action settles the UI and returns a compact AX snapshot. Occluded windows capture through
  ScreenCaptureKit filters; minimized and off-display windows fail explicitly. A changed focused
  window requires selecting a new explicit window target.
- Helper output is bounded before line splitting (`output-limit` tests); a cut-short or
  oversized reply fails its request, never the session.
- Error text is `PublicToolError` / `ScreenStopError` / `HelperCommandError` text: model- and
  person-facing strings are contract, byte for byte.

## 4. Measured (2026-11-23, M4 Max, load average 50 to 140)

Real `computerToolkit` and `ComputerClient` over the fake helper processes of
`computer/testing/world.ts`, 200 calls each: daemon CPU per call 251 µs for `screen_state`,
157 µs for a six-character `screen_act` type, 120 µs for a key; p50 0.11 to 0.14 ms; two helper
processes for 600 calls. Existing benches: fragmented v2 JPEG packet 18.7 µs, Zod validation of a
256-node UI reply 163 µs, a 1 MiB MCP image result 479 µs, a bounded 1 KiB helper line 8.9 to
14 µs, 128 KiB frame decode 5.3 µs, latest-frame fan-out 0.09 µs per offer
(`bench/v2.ts`, `content.ts`, `control-output.ts`, `stream.ts`). The session path through a fake
helper process (`bench/daemon-actions.ts`): `screen_input` median 12.8 ms against a 10 ms
fixture round trip. A real helper's settle and capture take tens to hundreds of milliseconds per
call; nothing here drove a real screen or app.

## 5. The tests that guard this, and which carry over

Classes as in [docs/devices/behaviour.md](../devices/behaviour.md) §5. † drives the real helper
against owned fixture apps or real windows (`ACE_SCREEN_INTEGRATION=1`, `ACE_COMPUTER_LIVE=1`,
or a real Linux session): never run by builders.

### (a): 47 files

`audit.process`, `background.process`, `behavior.process`, `bridge.process`, `capture-pacing.native.process`, `computer/client.process`, `computer/linux.process`, `computer/locked-use-gate.process`, `computer/timing.process`, `computer/toolkit.process`, `controller-binding.process`, `device-stream-review.process`, `frame-picture`, `frames.process`, `helper-identity.native.process`, `helper-routing.process`, `helper.process`, `identity.native.process` †, `install.process`, `key-contract.process`, `lifecycle-review.process`, `linux-session`, `locked-use-connection.process`, `locked-use-detect`, `locked-use-host`, `locked-use-mac`, `locked-use-wire`, `manager.process`, `mcp.process`, `measurement.native.process` †, `measurement.process`, `native-linux-wire.process`, `native-reply-budget.process`, `native.process` †, `output-limit.process`, `output-review.process`, `recording-media.process`, `review-safety.process`, `semantic.native.process` †, `shutdown.process`, `simulator.process`, `stream-owners`, `tools.process`, `ui-results.process`, `v2.process`, `video-status.process`, `windows.process`.

`computer/client.process`, `computer/locked-use-gate.process` and `locked-use-connection.process` import `systemScheduler` (`runtime.ts`) only to pass real time; `computer/toolkit.process` imports `computerSchemas` to read the advertised schema; `lifecycle-review.process` and `windows.process` build `Helper` with `spawnWindowsHelper` (`helper.ts`). Each tests through the public classes. `*.native.process` files not marked † skip unless the built helper is present (`skipIf(!binary)`).

### (b): 24 files

| File                                   | Internal it reaches (module.export)                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computer/actions`                     | computer/actions.ComputerAction computer/schemas.computerSchemas                                                                                                                                                                                                                                                  |
| `computer/background.native.process` † | computer/wire.ComputerActResult computer/wire.ComputerHello computer/wire.ComputerState                                                                                                                                                                                                                           |
| `computer/front.native.process` †      | computer/wire.ComputerActResult computer/wire.ComputerHello computer/wire.ComputerState                                                                                                                                                                                                                           |
| `computer/helper-connection.process`   | runtime.systemScheduler computer/helper-connection.HelperConnection                                                                                                                                                                                                                                               |
| `computer/outline`                     | computer/outline.baselineOf computer/outline.findLines computer/outline.idRanges computer/outline.nodeLine computer/outline.outlineBody computer/outline.outlineLines computer/outline.stateFooter computer/outline.stateHeader computer/wire.ComputerState computer/wire.ComputerNode computer/wire.ComputerNode |
| `computer/physical-input`              | computer/physical-input.frontmostApp computer/physical-input.hidIdleMs                                                                                                                                                                                                                                            |
| `computer/policy-hosts`                | computer/policy.blockedReason                                                                                                                                                                                                                                                                                     |
| `computer/timing`                      | computer/timing.ComputerRequestSpan                                                                                                                                                                                                                                                                               |
| `computer/uia-engine.native.process`   | computer/wire.ComputerActResult computer/wire.ComputerHello computer/wire.ComputerState                                                                                                                                                                                                                           |
| `linux.process`                        | linux.linuxLaunch                                                                                                                                                                                                                                                                                                 |
| `locked-use-attempt.process`           | locked-use-attempt.ProtectedAttempt runtime.systemScheduler                                                                                                                                                                                                                                                       |
| `locked-use-handshake`                 | locked-use-handshake.lockedUseDaemonProof locked-use-handshake.lockedUseProofEquals locked-use-handshake.lockedUseServiceProof                                                                                                                                                                                    |
| `media-backlog.process`                | media-source.ScreenMediaSource                                                                                                                                                                                                                                                                                    |
| `media-ingest.linux.process` †         | linux.linuxLaunch media-source.screenOpeningEpoch                                                                                                                                                                                                                                                                 |
| `media-ingest.native.process` †        | media-source.screenOpeningEpoch                                                                                                                                                                                                                                                                                   |
| `media-recovery`                       | media-source.ScreenMediaSource                                                                                                                                                                                                                                                                                    |
| `media-source`                         | frames.wireFrame helper-codecs.helperEncodesVideo media-source.egressScreenFrame media-source.ScreenMediaSource                                                                                                                                                                                                   |
| `permission-model`                     | permission-model.desktopAccessFailure permission-model.actionPermissionFailure permission-model.captureRevokedMessage permission-model.hostPermissions permission-model.unavailablePermissions                                                                                                                    |
| `picture-restart.process`              | picture-source.ScreenPictureSource                                                                                                                                                                                                                                                                                |
| `picture-source`                       | picture-source.ScreenPictureSource                                                                                                                                                                                                                                                                                |
| `picture-view.process`                 | picture-source.ScreenPictureSource                                                                                                                                                                                                                                                                                |
| `policy`                               | policy.authorizeInput policy.Control                                                                                                                                                                                                                                                                              |
| `public-failure`                       | public-failure.screenPublicFailure                                                                                                                                                                                                                                                                                |
| `shutdown-failure`                     | shutdown-failure.shutdownFailure                                                                                                                                                                                                                                                                                  |

### In the daemon (`apps/daemon/src/`, 21 files)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Class | What it guards                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `screen.server.process`, `screen.remote.process`, `screen-linux.remote.process`, `screen-access.server.process`, `screen-agent-access.process`, `screen-mcp.server.process`, `screen-unavailable.process`, `screen-queued-cancel.process`, `acp-screen-bridge.process`, `agent-computer-journey.process`, `measurement-mcp.server.process`, `measurement-step.process`, `locked-use.server.process`, `spade-computer-screen.process`, `computer-locked-use.process` | a     | socket, relay and MCP access to screens; queued cancel; a whole computer-use journey; measurement; locked use through the server; Spade's computers    |
| `screen-helper-path`, `computer-name`, `computer-using`, `locked-use-installer`, `locked-use-privileged`, `locked-use-runtime.process`                                                                                                                                                                                                                                                                                                                              | b     | daemon modules of the same names (helper path choice, naming, the "using the computer" state, the locked-use installer, privileged runner and runtime) |

Counts: 62 (a) files (4 of them live), 30 (b) (4 live), 0 (c).
