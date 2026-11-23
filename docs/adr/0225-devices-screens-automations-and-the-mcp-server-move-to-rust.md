# 0225: Devices, screens, automations and the MCP server move to Rust

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: the owner chose the full
port on 2026-11-23, knowing the measurements below; the design is pending the owner.
Revised the same day: the first draft kept the four areas in TypeScript; the owner overruled it.
Round 2 after review (2026-11-23): mixed-mode locked-use authority, the scrcpy handshake, the
stdio bridge's two protocol paths, M3's start write, webhook compatibility, D2's recovery, the
Simulators owner, platform gates, and a language-neutral catalog.
Round 3 (2026-11-23): a revocation generation fencing locked-use admission, the stdio bridge's
validation, admission and aggregate budgets, D1's single startup deadline and control-first
case, D2's liveness reconcile, the secret envelope read as the TypeScript reads it, and catalog
checks over rendered guidance and per-caller listings.

## Context

The owner is moving the daemon to Rust: the CLI ([ADR 0221](0221-the-ace-cli-is-a-rust-management-tool.md)),
the store ([ADR 0222](0222-the-event-store-moves-to-rust-behind-the-same-store.md)), the engine
and adapters ([ADR 0223](0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md))
and git (ADR 0224, on `ace/rust-git-forge`). This ADR moves `@ace/devices`, `@ace/screen`, `@ace/automations` with the
daemon's automation executor and monitor, and `@ace/mcp-server`. Their contracts and every test
file's class are in [docs/devices/behaviour.md](../devices/behaviour.md),
[docs/screen/behaviour.md](../screen/behaviour.md),
[docs/automations/behaviour.md](../automations/behaviour.md) and
[docs/mcp-server/behaviour.md](../mcp-server/behaviour.md).

ADR 0222's "Measured after building" and the translator work (E1 and its review fixes) set the
rules this one follows: output that JavaScript or a model reads must be byte-identical to what the
TypeScript produces, and every port so far that approximated it diverged again and again; a Rust
path that hands JSON to JavaScript to parse again can be slower than the TypeScript; the existing
TypeScript tests are the proof.

### What there is

| Area                                                   | Source lines  | Modules | Test files (a / b / c, with daemon tests)               |
| ------------------------------------------------------ | ------------- | ------- | ------------------------------------------------------- |
| `@ace/devices`                                         | 18,462        | 124     | 46 / 41 / 0                                             |
| `@ace/screen`                                          | 14,516        | 98      | 62 / 30 / 0                                             |
| `@ace/automations` + `apps/daemon/src/automation-*.ts` | 3,504 + 2,452 | 23 + 11 | 34 / 8 / 0                                              |
| `@ace/mcp-server`                                      | 8,947         | 66      | 52 / 6 / 0 (21 outside-endpoint files not in this move) |

Already native: the macOS screen helper (Swift), the Linux and Windows screen helpers (Rust),
the locked-use service, and ace-media (Rust, its own processes), which since
[ADR 0208](0208-ace-media-is-the-only-media-and-image-pipeline.md) does all encoding, delivery,
recording, stills and image work. No TypeScript decodes or encodes a pixel.

### Measurements

Taken 2026-11-23 on an M4 Max shared with other builds (load average 50 to 140), Bun 1.4.4, with
the packages' own benches and fakes and a daemon started in process on an empty temporary home
(`HOME` and `ACE_HOME` both temporary; no provider, real simulator, device, screen or app was
used, and no quota spent). Times are noisy; counts and shares are not.

| What                                                                                           | Measured                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP: registry dispatch / HTTP round trip through the SDK (`bench/dispatch.ts`)                 | 2.4 µs / 171–224 µs                                                                                                                             |
| MCP: real daemon, 50 tools: `tools/list` (53 KB) / core listing (11 KB) / `tools/call context` | p50 0.57–1.36 ms / 0.17–0.30 ms / 0.65–1.03 ms                                                                                                  |
| MCP: CPU profile of 7,500 daemon requests (`bun --cpu-prof-md`)                                | daemon store work around each call about 55% (recording the call 23–25%, change digest 12%, availability 6%); Zod about 8%; SDK and HTTP 10–15% |
| Computer use: real toolkit and client over fake helper processes                               | 120–251 µs of daemon CPU per call; 2 helper processes for 600 calls                                                                             |
| Computer use: Zod check of a 256-node helper reply / 1 MiB image result                        | 163 µs / 479 µs                                                                                                                                 |
| Devices: `sim_list` / `sim_ui` (120 nodes) / `sim_act` on a ref / at a point                   | 78 / 636 / 474 / 51 µs of CPU per call                                                                                                          |
| Frames in JavaScript: 128 KiB framing / picture assembly / fan-out                             | 4.7–5.3 µs / 4.2 µs / 0.09–0.27 µs                                                                                                              |
| A supervised spawn of `/usr/bin/true` (daemon CPU)                                             | 1.25 ms (0.28 ms for a bare `spawnSync`)                                                                                                        |
| Device inventory while a view watches it                                                       | 3 SDK commands every 4 s (`simctl list`, `emulator -list-avds`, `adb devices -l`); none otherwise                                               |
| Android video through JavaScript                                                               | every H.264 unit crosses the JS thread twice (scrcpy socket → ingest, egress back); iOS once (egress)                                           |
| Automations: next occurrence / indexed next deadline / durable admission                       | 11–18 µs / 14 µs / 232–449 µs                                                                                                                   |
| Automations: one supervised `gh` call / a 1,000-PR poll with 8 KB bodies                       | 42 ms / 53–432 ms (1 to 1,000 changes)                                                                                                          |
| Automation run monitor                                                                         | an indexed read of the run's turn every 5 s per active run                                                                                      |

Calls arrive at the rate models make them, seconds apart per agent; a helper's UI settle or a
simulator command takes tens to hundreds of milliseconds; a poll runs at most once a minute.

### What the measurements say, recorded for the decision

None of the four is slow because it is TypeScript. Pixels, codecs, capture, accessibility and
input are native already (ace-media, the screen helpers); the TypeScript is control logic costing
microseconds against work that takes milliseconds to seconds. The owner chose the full port
anyway (2026-11-23): one daemon core in Rust, the TypeScript shell gone area by area. Three
findings become requirements of the Rust design, because each is a real cost the port can remove:

1. **About 55% of an MCP call's CPU is the daemon's own store work** around it (two write
   transactions to record the call, `apps/daemon/src/tool-result-mcp.ts:199`–`:263`; a full read
   of the session's facts for the change digest, `packages/mcp-server/src/awareness.ts:118`;
   status for availability). The Rust server is designed lean (§5, M3).
2. **Device inventory polls three SDK commands every 4 s** while a view watches it. The Rust
   inventory is pushed, not polled (§5, D2).
3. **Android video crosses the JS thread twice per unit**, so a main-thread stall stalls it.
   ace-media reads scrcpy's video socket itself (§5, D1).

## Decision

### 1. Safeguards for every phase

1. **JavaScript-visible output goes through `ace-json`.** Tool results, model-facing text, wire
   messages, stored JSON and anything a Zod schema shaped are written with
   `native/daemon/crates/ace-json` (`to_string`, `ObjectWriter`, derived serializers in the
   schema's key order), so they match `JSON.stringify` byte for byte. No `serde_json` on a value
   JavaScript, a client or a model reads.
2. **Provider and OS strings are `ace_json::JsString`** end to end: device names, bundle ids,
   window titles, AX labels, helper messages, `simctl`/`adb`/`gh` output, GitHub bodies, prompts,
   tool arguments. Lengths, slicing and limits count UTF-16 code units as the TypeScript does
   (`.length`, `.slice`), and lone surrogates survive.
3. **One language-neutral source for descriptors and words, read by both sides.** The TypeScript
   is deleted after rollout, so it can't stay the source. MCP M1 moves the canonical copy into
   JSON files under `native/daemon/catalog/` (each tool's descriptor as `tools/list` serves it,
   the `PublicToolError` catalog's messages and next steps, instructions, guide topics, session
   guidance, control hints, listing headers, and each area's refusals and hints), exported once
   from today's TypeScript. From then on the TypeScript imports its words from those files
   (`with { type: "json" }`) and Rust embeds them (`include_str!`, parsed with `ace-json`);
   neither retypes them. Zod schemas stay the TypeScript validators while it runs; the descriptor
   in the catalog is the contract. Two checks in `bun run check:daemon-native` keep them honest,
   over fixture callers the catalog also holds (capability sets, groups off, listing modes, client
   headers, tool search, opened toolsets, ended leases, fixture session facts):
   `check:catalog-listing` compares, per caller and per built backend, the live `tools/list`,
   `initialize` instructions, `resources/list`, `ace://session` (brief, roles, facts), a digest,
   each provider's session guidance and the `guide`/`tools_find` results byte for byte with the
   catalog, and `z.toJSONSchema` of every live registration with its entry;
   `check:catalog-text` renders every public error code, refusal and hint through each backend's
   live path and compares the bytes (MCP porting guide, M1). After the
   TypeScript is gone, the same checks run against Rust alone, so the catalog stays the source.
4. **Every phase is behind a switch, off by default**, read once by
   `packages/provider-kit/src/native-switches.ts` (ADR 0223 E0). Set without its native part, the
   daemon refuses to start. Each phase is proven by its class (a) tests run alone with the switch
   on and off, plus the cross-mode list where it leaves rows (ADR 0223 §8), on macOS, Linux and
   Windows where the area runs.
5. **Where a TypeScript behaviour can't be reproduced exactly, that piece stays TypeScript** and
   the Rust side calls it through a port. This ADR names three (§4); a builder who finds another
   stops and asks rather than approximating.
6. **Tests move, they don't multiply.** No new tests, no parity harness; (b) cases move into
   `#[cfg(test)]` beside the Rust function that replaces them; live files (†) are the owner's.

### 2. Where the code goes

- **In process, in `native/daemon`** (the napi-rs addon of ADR 0222), one crate per area:
  `ace-devices`, `ace-screen`, `ace-automations`, `ace-mcp`. They act inside the store's
  transactions and against the engine's state, so the one-connection, one-SQLite-library rule of
  ADR 0222 §1 and §3 applies (`automations.sqlite` and `agent-automations.sqlite` open through
  `ace-store`'s connection factory too). Logic runs on the core's executor and pump (ADR 0223 §4);
  sockets, pipes, HTTP and timers on its tokio runtime.
- **The native helpers stay processes**: the macOS screen helper (Swift: AX, ScreenCaptureKit,
  SkyLight; its TCC grants belong to its own signed identity), the Linux and Windows helpers, the
  locked-use service, serve-sim, scrcpy-server, the Android UI helper. A crashing helper must not
  take the daemon down, and macOS attributes permissions per signed executable. `ace-screen` and
  `ace-devices` speak the same wires to them.
- **ace-media stays its own processes.** D1 adds a reader to it; the daemon's crates talk to it
  over its control wire using `native/media/crates/media-wire` as a path dependency (one wire
  definition, not two).
- **What stays outside these crates:** `DeviceClient` (`@ace/devices/client`) is client code that
  runs in the web and iOS apps; the injection helpers and MCP discovery belong to the adapters'
  sessions (ADR 0223 E3); `external-mcp` (ADR 0122's OAuth and grants) stays TypeScript on top of
  M2's `serve` hook until its own move.

### 3. Crates

| Need                               | Crate                                                                                                                           | Why, and what was rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP HTTP server                    | `hyper` 1, `hyper-util`, `http-body-util` (tokio)                                                                               | **`rmcp` rejected for the server, on evidence**: 3.11 speaks 2026-07-28 and the 2025 versions and validates `Mcp-Param-*` headers, but its model carries results and schemas as `serde_json::Map` and `String` (`rmcp-3.11.0/src/model.rs:45`, `model/tool.rs:27`), which cannot hold a lone surrogate and re-spell numbers (`1e21`, `1e-7`) unlike JavaScript. ace's own JSON-RPC layer over hyper, with `ace-json`, keeps the bytes. `rmcp` stays the Pi adapter's MCP client (ADR 0223 E3). |
| JSON                               | `ace-json`                                                                                                                      | safeguard 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| processes                          | `ace-supervisor` (ADR 0223 E2)                                                                                                  | every SDK command, helper, `gh` and scrcpy-server spawn, so all are contained and in the inventory (this also brings the computer-use helpers, today spawned with `node:child_process`, under supervision)                                                                                                                                                                                                                                                                                     |
| scheduling                         | none: one timer on the core's clock, armed for the store's earliest deadline                                                    | **`tokio-cron-scheduler` rejected**: in-memory jobs with their own persistence, and standard cron runs an autumn fold twice, against ADR 0015's once-at-the-first-instant. The scheduler stays a database query (`store.ts:314`'s index) plus one timer                                                                                                                                                                                                                                        |
| file and directory watches         | `notify` 8 (FSEvents, inotify, ReadDirectoryChangesW)                                                                           | the AVD folder and the CoreSimulator device set as triggers for D2                                                                                                                                                                                                                                                                                                                                                                                                                             |
| adb                                | none: the adb server's host protocol over `tokio::net::TcpStream`                                                               | `host:track-devices-l` is a length-prefixed text protocol on 127.0.0.1:5037; a crate adds nothing (the few on crates.io are unmaintained or GPL)                                                                                                                                                                                                                                                                                                                                               |
| emulator gRPC (`streamScreenshot`) | `hyper` HTTP/2 client + `prost` with hand-written message structs                                                               | the TypeScript uses only a few fields over `node:http2` (`emulator-grpc.ts`); `tonic` would add codegen for one call                                                                                                                                                                                                                                                                                                                                                                           |
| crypto, key files                  | `aes-gcm`, `hmac`, `sha2`, `subtle` (RustCrypto, Apache-2.0/MIT); `rustix` for `O_NOFOLLOW`, `O_NONBLOCK`, `O_EXCL` and `fstat` | webhook secret box (AES-256-GCM), webhook signatures and the locked-use handshake (HMAC-SHA256, constant-time compare)                                                                                                                                                                                                                                                                                                                                                                         |
| errors, cancellation               | `thiserror`, `tokio-util` `CancellationToken`                                                                                   | as ADR 0223                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Windows pipes, Unix sockets        | `tokio::net::windows::named_pipe`, `tokio::net::UnixStream`                                                                     | the screen helpers' frame endpoints and the locked-use socket                                                                                                                                                                                                                                                                                                                                                                                                                                  |

All checked against `native/daemon/deny.toml` (permissive licences, crates.io only, plus the
`media-wire` path dependency).

### 4. What stays TypeScript, and why

1. **Recurrence and the calendar** (`@ace/automations/recurrence`, `/calendar`). Zone rules come
   from the runtime's ICU through `Intl.DateTimeFormat` (`calendar.ts:34`); a Rust zone database
   (`jiff`'s bundled or the system's zoneinfo) can disagree at a tzdata change, and the same code
   runs in `packages/ui-core` (web and iPhone) and `packages/fake-daemon`, where a second
   implementation would be duplicate logic. The Rust scheduler calls `compileSchedule` through a
   synchronous port (`next`, `seek`), microseconds per call, a few calls per occurrence.
2. **The wording of rejected tool arguments.** `invalid_arguments` text is built from Zod's issues
   (`tool-failure.ts:10`, `argument-issues.ts`) for every tool's schema; reproducing Zod's issue
   list for about 50 schemas is the approximation the safeguards forbid. A tool's input is decided
   by its Zod schema in TypeScript (a synchronous port call, about 2 µs) until its family's Rust
   handler (M4) has typed decoding whose accept and reject decisions its (a) tests pin; the
   rejection's words are always produced by the Zod port.
3. **`DeviceClient`** and the other client-side code: it runs in the apps, not the daemon.

### 5. Phases, each depending only on merged work

Switches are in §6, proof per phase in the porting guides. "Needs" lists what must be merged (and
default-on where it says so) first.

#### Devices

| Phase | What moves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Interface kept                                                                                                                 | Needs                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| D1    | ace-media reads an Android device's scrcpy video socket itself (its wire already has `scrcpy {host, port}`, `media-wire/src/control.rs:130`); the daemon keeps scrcpy-server and the control socket and stops forwarding units; the handshake keeps today's order (dummy byte, then `greeted`, then control connects, then name and codec; `scrcpy-server.ts:175`–`:196`) and both socket owners end together on cancel or failure; one startup deadline covers every step, the control connect included; video-off stays the daemon's                                                                                                                                 | `startCapture`, the capture's `VideoUnit`s off egress                                                                          | nothing                |
| D2    | the inventory, pushed: `adb` `host:track-devices-l` for transports, `notify` on the AVD folder (`ANDROID_AVD_HOME` or `~/.android/avd`) to re-run `emulator -list-avds`, `notify` on the CoreSimulator device set to re-run `simctl list` (debounced); a watch is only a trigger, the SDK read stays authoritative, and every source has a health state: a full reconcile read on view start, source start and every reconnect; dead or overflowed watches and a closed track socket reconnect with backoff; while a source is unhealthy its list falls back to today's 4 s read while viewed; a 60 s liveness reconcile runs while viewed whatever the sources report | `DevicesService.watchInventory`, `holdInventoryView`, `list` (`inventory.ts`'s `InventoryWatch`)                               | E2                     |
| D3    | the platform: `Simulators` (moved here from `@ace/screen`, D3.1; S2.2 takes it from `ace-devices`), SDK commands (`simctl`, `devicectl`, `plutil`, `adb`, `emulator`), SDK and tool discovery (`sdk.ts`, `sdk-roots.ts`, `android-tools.ts`, serve-sim install and version), the Android UI helper, input shell, digitizer, serve-sim control, scrcpy-server and control, emulator gRPC, logs, clipboard, posture, chrome and skins (pixels through ace-media's image process)                                                                                                                                                                                         | `DevicePlatform` (tests subclass it: a JavaScript platform is driven through a `JsPlatform` bridge, as ADR 0223's `JsSession`) | E2, D1                 |
| D4    | the service: leases, tickets, epochs, cowork, ownership, sessions and captures, recordings' control, refs, the bridge's decisions, `sim-tools` (the CLI path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `DevicesService` (a facade with the same methods and timing), `connectDevices`/`reserveDevices`                                | D3, `ACE_STORE=native` |
| D5    | the `sim_*` tool family's handlers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `devicesToolkit`'s tools in M2's registry                                                                                      | D4, M2                 |

#### Screens and computer use

| Phase | What moves                                                                                                                                                                             | Interface kept                                                                                                                                | Needs                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S1    | `ComputerClient`: the helper pool (six, LRU, five-minute idle exit), the JSON-lines wire with lenient decoding, deadlines, `cancel`, 3 s grace, per-app kill, 32 MiB reply cap, timing | `ComputerClient` (`computer/client.ts:96`)                                                                                                    | E2                                                                                          |
| S2    | sessions: `ScreenManager` (v1/v2 helper wire, frame endpoints, stream owners, `ScreenMediaSource` over ace-media's wire, recordings, Simulators, measurement, permissions, policy)     | `ScreenManager` (`manager.ts:51`), `screenConnection`, `localScreenManager`                                                                   | E2; `Simulators` from D3.1, or the TypeScript one through a port until D3.1 merges          |
| S3    | locked use: connection and handshake, protected attempts, the gate, the Mac host and installer                                                                                         | the `locked-use-*` exports (`index.ts:56`–`:103`)                                                                                             | S1                                                                                          |
| S4    | the `computer` family (`screen_apps`, `screen_state`, `screen_act`, `screen_display`: outline and diff, policy, actions, cowork) and the session tools (`screenToolkit`)               | their tools in M2's registry, calling the process's one locked-use gate (`apps/daemon/src/computer-locked-use.ts:10`) whether S3 is on or off | S1, S2, M2; default-on only after S3 passes the four-way locked-use matrix (S3 × S4 on/off) |

#### Automations

| Phase | What moves                                                                                                                                                                                                                                                                                                                                                      | Interface kept                                                                 | Needs                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| A1    | the scheduler: `AutomationStore` (both files), `AutomationService` (put, CAS revisions, admission, queue, one timer, jitter, downtime recovery, inbox, trigger, retry, `handle`), GitHub polling over supervised `gh`, webhooks (keys, secret box, signatures, bodies), prompt rendering with `JsString`; recurrence through the port of §4                     | `AutomationService`, `AutomationStore`, `AutomationWebhooks`, `createGhClient` | E2, `ACE_STORE=native`                             |
| A2    | the run executor and monitor: `automation-run-executor`, `-monitor`, `-facts`, `-rules` (rule for rule, priority 1), `-record`; launch settings and titles stay generated text; the Cursor recovery case (`cursor-automation.process`: an existing Cursor automation launches on the SDK and recovery keeps the same thread) is in its gate and cross-mode list | `AutomationExecutor` (`contracts.ts:32`)                                       | ADR 0223 E5 default-on, A1                         |
| A3    | file triggers (`automation-workspace.ts`) over the files service's Rust API                                                                                                                                                                                                                                                                                     | `WorkspaceChanges` (`contracts.ts:53`)                                         | A1, the files tool's Rust backend                  |
| A4    | the automation tools (`automation_put`, `_remove`, `_run`, `automations_list`)                                                                                                                                                                                                                                                                                  | their tools in M2's registry                                                   | A1, M2, the agent-control port (M4's first family) |

#### MCP server

| Phase | What moves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Interface kept                                                                                                                                                 | Needs                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| M1    | the canonical catalog (safeguard 3), no behaviour change: every tool's descriptor, the `PublicToolError` catalog, instructions, guide topics, listing headers and each area's words into `native/daemon/catalog/*.json`; the TypeScript reads its words from them; the two catalog checks                                                                                                                                                                                                                                                                                                      | none                                                                                                                                                           | nothing                   |
| M2    | the server and registry: HTTP on hyper (127.0.0.1, Host and Origin checks, limits), leases and authentication, the JSON-RPC and MCP layer for 2026-07-28 and legacy 2025 sessions, SSE and `list_changed` streams with their bounds, listing modes, call order, budgets and one deadline, progress beats, the `serve`/`handleHttp` hooks; every tool still a JavaScript handler behind a `JsTool` bridge (input Zod, run, output check in TypeScript)                                                                                                                                          | `startMcpServer`'s result (`url`, `handleHttp`, `serve`, `credentials`, `awareness`, `toolsChanged`, `close`), `ToolRegistry`, `CredentialRegistry`, `Toolkit` | `ACE_STORE=native`, M1    |
| M3    | the lean per-call work (finding 1): the start write and its whole correlation transaction move unchanged (`tool-result-mcp.ts:175`–`:226`: binding the provider's tool item, invalidating ambiguous bindings), with cached statements and no extra reads; the finish write goes in the writer's batch where ADR 0222 phase 5 has landed; the digest's session facts are kept per session and updated from the store's published events instead of read per call; availability is cached per caller and group version; guidance, briefs, digests, roles and tool search in Rust with `JsString` | the `observeCall`, `AwarenessPort` and `StatusReader` ports, whose daemon implementations it replaces                                                          | M2                        |
| M4    | tool families' handlers in Rust, each when its owner is Rust: agent-control's (behind `AgentControlPort`, `control-tool.ts:15`, when agent-control's ADR lands), then devices (D5), computer and screen (S4), automations (A4), and guide, knowledge, notify, html, image, suit, market, measurement as their owners move; browser's when `@ace/browser` moves                                                                                                                                                                                                                                 | each toolkit's registration, schemas and words, unchanged                                                                                                      | M2 and the family's owner |
| M5    | the stdio bridge (`stdio-bridge.ts`, today a Bun process a stdio-only client spawns, `injection.ts:216`–`:220`) as a subcommand of the Rust `ace` binary (ADR 0221), keeping both protocol paths (`stdio-bridge.ts:60`–`:150`): requests POSTed one by one over stateless 2025-11-25 HTTP, the SSE event whose id matches selected, `notifications/cancelled` aborting the matching request, per-request deadlines; and a separate 2026-07-28 subscription forwarding `tools/list_changed`; same 32 MiB queue cap and result limits                                                            | `acpStdioInjection`'s command and arguments, the bridge's behaviour on stdio                                                                                   | M2, ADR 0221's CLI        |

Order across areas, from what is merged today (store 1a, phase 2 reads, E1, the CLI): D1 and M1 can start
now; D2, D3, S1, S2, A1 after E2; M2 and M3 after M1 (they need only the native store); D4 after
D3 (and S2.2 uses D3.1's `Simulators`, or the TypeScript one through a port until then); S3 after S1; M5 after M2; A2 after E5 is default-on; A3 after the files backend; D5, S4, A4 and every M4
family after M2 and their owner. A phase whose owner isn't merged doesn't start.

### 6. Switches

| Switch                                 | Phase          | Needs                                                         |
| -------------------------------------- | -------------- | ------------------------------------------------------------- |
| `ACE_SCRCPY_VIDEO=media`               | D1             | an ace-media build with the scrcpy reader                     |
| `ACE_DEVICE_INVENTORY=native`          | D2             | `ACE_SUPERVISOR=native`                                       |
| `ACE_DEVICE_PLATFORM=native`           | D3             | `ACE_SUPERVISOR=native`                                       |
| `ACE_DEVICES=native`                   | D4             | `ACE_STORE=native`; works over either platform                |
| `ACE_COMPUTER_CLIENT=native`           | S1             | `ACE_SUPERVISOR=native`                                       |
| `ACE_SCREEN=native`                    | S2             | `ACE_SUPERVISOR=native`                                       |
| `ACE_LOCKED_USE=native`                | S3             | `ACE_COMPUTER_CLIENT=native`                                  |
| `ACE_AUTOMATIONS=native`               | A1             | `ACE_STORE=native`, `ACE_SUPERVISOR=native`                   |
| `ACE_AUTOMATION_EXECUTOR=native`       | A2             | `ACE_ENGINE=native`, `ACE_AUTOMATIONS=native`                 |
| `ACE_AUTOMATION_WORKSPACE=native`      | A3             | `ACE_AUTOMATIONS=native` and the files backend's switch       |
| `ACE_MCP=native`                       | M2             | `ACE_STORE=native`                                            |
| `ACE_MCP_CALLS=native`                 | M3             | `ACE_MCP=native`                                              |
| `ACE_NATIVE_TOOLS=<family>[,<family>]` | D5, S4, A4, M4 | `ACE_MCP=native` and the family's owner switch                |
| `ACE_MCP_STDIO=native`                 | M5             | the provider's injection names the Rust `ace` binary when set |

M1 has no switch: it moves the catalog and adds its checks, with no behaviour change. `ACE_NATIVE_CROSS` (ADR 0223 §8)
learns the switches whose phase leaves rows another backend must read after a restart:
`ACE_DEVICES` (the stored devices switch and bindings), `ACE_SCREEN` (the stored screen switch),
`ACE_AUTOMATIONS`, `ACE_AUTOMATION_EXECUTOR`, `ACE_MCP_CALLS` (call records) and each
`ACE_NATIVE_TOOLS` family with rows of its own.

### 7. How each boundary keeps the output

- **Facades over handles**, as ADR 0223 §6: `DevicesService`, `DevicePlatform`, `ScreenManager`,
  `ComputerClient`, `AutomationService`, `AutomationStore`, `startMcpServer`'s result and
  `ToolRegistry` keep their TypeScript classes and signatures; with the switch on each is a thin
  facade whose methods are binding calls of the same timing (what is synchronous stays
  synchronous; promises the Rust task resolves). Values cross as `ace-json` text or plain values.
- **JavaScript implementations stay pluggable** while tests use them: a test's `FakeSimPlatform`
  subclasses `DevicePlatform`, the computer-use world spawns fake helpers through
  `spawnHelper`, automations' tests pass executor and timer fakes, the MCP tests register their
  own tools. Each Rust service drives a JavaScript port through a bridge on the JS thread, so the
  (a) tests run unchanged.
- **Words come from generated tables or the TypeScript.** Refusals ("A person is controlling this
  device", "Only a person can do this", "No change since your last look.", "Skipped: new work was
  paused."), the public error catalog, guidance and briefs are read from the canonical catalog by
  both sides (safeguard 3), or produced by the TypeScript (§4). Text from helpers, SDKs, GitHub and providers passes
  through untouched as `JsString`.
- **Wire formats are the same bytes**: the helpers' JSON lines and frame packets, ace-media's
  control wire, scrcpy's control messages, `devices.*` and `screen.*` socket messages, MCP
  responses and SSE events. The socket server stays TypeScript (ADR 0223 §6) and forwards the
  `ace-json` bytes the services produce without parsing them again where it can (ADR 0222 §5's
  encodings seed).

### 8. Proof

Each porting guide lists, per phase, the (a) files to run with the switch on and off, the (b)
cases to move, the cross-mode list, and the bench to compare. Counts: devices 46 (a) / 41 (b),
screen 62 / 30, automations 34 / 8, MCP 52 / 6, with 21 outside-endpoint files run with
`ACE_MCP=native` as well. A phase is default-on only after its (a) files pass both ways on every
platform it runs on (Linux and the Windows VM for S1, S2, D2's watches, D3.1's `adb` and D3.3's
emulator gRPC stream, and M2), its cross-mode list
passes both ways, and its bench is no worse than the TypeScript (the devices and computer-use
live benches are run by the owner).

## Consequences

- The daemon's devices, screens, automations and MCP endpoint become Rust, phase by phase, with
  the TypeScript removed one release after each phase is default-on.
- Measured speed changes little: the recorded measurements show these areas spend their time in
  native helpers, SDK commands and models. The gains are the three findings: leaner MCP calls
  (about half their CPU), no inventory polling, and Android video off the JS thread; plus one
  supervisor for every child process.
- Two TypeScript pieces remain by design (recurrence with ICU zones, Zod's argument wording)
  until the JavaScript runtime leaves the daemon; then they need their own decision (question 2).
- Every tool family needs its owner in Rust before its handler moves, so M4 trails agent-control
  and the other owners; until then the Rust server bridges to JavaScript handlers at about
  2 µs a call.
- `native/daemon` depends on `native/media`'s wire crate by path; the two workspaces build
  together in development and release.

## Questions for the owner

1. **Cross-area order.** Start D1 and M1 now, then the E2-dependent phases (D2, D3, S1, S2, A1)
   as soon as E2 merges, and M2/M3 alongside; accept?
2. **The two TypeScript pieces.** When the JavaScript runtime leaves the daemon, port recurrence
   with ICU4X's zone data (and ship it to `ui-core` as WebAssembly), and validate arguments with
   typed decoders whose rejection words are generated per schema? Or keep a small JavaScript
   runtime for them?
3. **D2's Simulator trigger.** A watch on the CoreSimulator device set as the trigger for
   `simctl list`, with today's 4 s read while viewed as the fallback when the watch can't start;
   accept the fallback?
4. **D1's connection order**: ace-media connects scrcpy's video socket before the daemon connects
   control; accept?
5. **M3 keeps both writes** (review, 2026-11-23): the start row reserves the provider's tool item
   and invalidates ambiguous bindings during normal execution, so it moves unchanged; M3's
   savings come from the digest and availability. Accept?
6. **Platform gates**: S1, S2, D2, D3.1, D3.3 and M2 default-on wait for Linux and the Windows VM
   runs; accept?
7. **When the TypeScript goes**: one release after each phase is default-on (recommended)?
