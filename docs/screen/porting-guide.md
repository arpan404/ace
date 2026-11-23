# Porting screens and computer use to Rust

For the builders who move `@ace/screen` into `native/daemon` (`ace-screen`), one work item each.
Read [ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §5 lists
every test file by class. The [devices porting guide](../devices/porting-guide.md)'s rules for
every item apply here unchanged (same interface, one switch, facades that grow method by method,
no new tests, (b) cases move, `ace-json` and `JsString`, words from the catalog, same numbers, every child
through `ace-supervisor`, Rust rules, build and check, commit and push); this guide adds what is
particular to screens.

Branch from `ace/daemon-rust-rewrite` once the item's needs are merged, one branch per item
(`ace/rust-screen-<item>`).

## Rules particular to screens

1. **The helpers stay native processes and their wires stay byte for byte.** The macOS helper is
   Swift (AX, ScreenCaptureKit, SkyLight focus, its own TCC identity); the Linux and Windows
   helpers are their own Rust binaries. You change the daemon's side only: `hello`, `apps`,
   `resolve`, `state`, `act`, `cancel` JSON lines for computer use; the v1/v2 session wire and
   frame packets (`frames.ts`) for sessions; the locked-use socket protocol. Don't link a helper
   into the daemon.
2. **Lenient wire decoding.** Replies decode into enums with an `Unknown` variant holding the raw
   `ace_json::Raw`; unknown fields stay; a malformed or oversized reply fails its request, never
   the session or the process (`output-limit`, `native-reply-budget` tests).
3. **The person wins (priority 1).** An action refuses while the person uses the same app; Esc
   stops agent activity; cowork makes the agent wait (`ScreenCowork.yield`, `cowork.ts:97`); a
   takeover epoch is checked on the first action after it. Port these rule for rule and keep their
   order.
4. **Text the model reads**: outlines and diffs (exactly "No change since your last look."),
   refusals (`blockedReason`, `computer/policy.ts:245`), the step results of `screen_act`, error
   messages. ace's own words from `native/daemon/catalog/screen.json` (ADR 0225 safeguard 3); helper messages pass through as `JsString`.
   Outline lines are built with `JsString` and UTF-16 lengths, as `computer/outline.ts` does.
5. **Never run a † file** (`*.native.process` gated on `ACE_SCREEN_INTEGRATION`/`ACE_COMPUTER_LIVE`,
   the Linux and native media-ingest files) or the benches that operate apps
   (`computer-actions.ts`, `computer-e2e.ts`, `computer-real-apps.ts`, `live-view.ts`,
   `interaction.ts`, `identity.ts`, `search.ts`). Measure with `bench/computer-world.ts`,
   `daemon-actions.ts`, `v2.ts`, `content.ts`, `control-output.ts`, `stream.ts`.
6. **Windows**: named pipes through `tokio::net::windows::named_pipe` (`windowsEndpoint`,
   `transport.ts`); S1 and S2 pass in the Windows VM before default-on.

## Files per item

| Item | Rust (yours)                                                 | Binding (yours)                            | TypeScript shell (yours)                                 | Switch                                 |
| ---- | ------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------- | -------------------------------------- |
| S1   | `ace-screen/src/computer/{client,connection,wire,timing}.rs` | `ace-daemon-node/src/screen/computer.rs`   | `packages/screen/src/native-computer-client.ts`          | `ACE_COMPUTER_CLIENT=native`           |
| S2   | `ace-screen/src/session/<area>.rs`                           | `ace-daemon-node/src/screen/manager.rs`    | `packages/screen/src/native-manager.ts`                  | `ACE_SCREEN=native`                    |
| S3   | `ace-screen/src/locked_use/*.rs`                             | `ace-daemon-node/src/screen/locked_use.rs` | `packages/screen/src/native-locked-use.ts`               | `ACE_LOCKED_USE=native`                |
| S4   | `ace-screen/src/tools/{computer,session}.rs`                 | `ace-daemon-node/src/tools/screen.rs`      | the family line in `computerToolkit` and `screenToolkit` | `ACE_NATIVE_TOOLS=computer`, `=screen` |

## S1: `ComputerClient` (needs E2)

The pool, one helper per target app (at most six, LRU idle eviction, five-minute idle exit,
`computer/client.ts:221`–`:229`), the shared catalog helper, deadlines (`act` 85 s, `state` 40 s,
others 15 s, `:80`), `cancel` with a 3 s grace then a kill of that app's helper only (`:183`),
the 32 MiB reply cap (`:181`), restart after exit, timing spans. Helpers are spawned through
`ace-supervisor` (today `node:child_process`, `:255`), so they join the process inventory and
containment; `spawnHelper` stays an option, and a JavaScript one (the tests') is driven through a
bridge.

| TypeScript replaced (`packages/screen/src/`)                                                                                                       | Proof: (a) files                                                                                                                               | (b) cases to move                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `computer/client`, `computer/helper-connection`, `computer/reply-lines`, `computer/wire`, `computer/timing`, `computer/errors`, `computer/session` | `computer/client.process`, `computer/timing.process`, `computer/linux.process`, `computer/toolkit.process`, `computer/locked-use-gate.process` | `computer/helper-connection.process`, `computer/timing` |

## S2: sessions (needs E2)

`ScreenManager` and what it owns, landing in this order under one switch:

| Item | TypeScript replaced (`packages/screen/src/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Proof: (a) files                                                                                                                                                                                                                                                                                                                                                                                                                           | (b) cases to move                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S2.1 | the helper and its wire: `helper`, `helper-host`, `helper-session`, `helper-codecs`, `host`, `install`, `transport`, `endpoint`, `linux`, `linux-session`, `frames`, `frame-hub`, `frame-picture`, `pixels`, `runtime`, `options`                                                                                                                                                                                                                                                                                     | `helper.process`, `helper-routing.process`, `frames.process`, `frame-picture`, `install.process`, `key-contract.process`, `linux-session`, `native-linux-wire.process`, `native-reply-budget.process`, `output-limit.process`, `output-review.process`, `lifecycle-review.process`, `windows.process`, `v2.process`                                                                                                                        | `linux.process`                                                                                                                              |
| S2.2 | sessions and control: `manager`, `session`, `session-controllers`, `session-observations`, `target-sessions`, `target-busy`, `controller-binding`, `agent-binding`, `execution-slots`, `action-execution`, `legacy-input`, `app-launches`, `app-session`, `app-windows`, `semantic`, `ui-results`, `access`, `access-policy`, `policy`, `device-input-policy`, `permission-facts`, `permission-model`, `public-failure`, `stop-error`, `shutdown-failure`, `simulator`, `cowork`, `computer/physical-input`, `bridge` | `manager.process`, `controller-binding.process`, `background.process`, `behavior.process`, `audit.process`, `review-safety.process`, `shutdown.process`, `simulator.process`, `ui-results.process`, `bridge.process`, `device-stream-review.process`; daemon `screen.server.process`, `screen.remote.process`, `screen-linux.remote.process`, `screen-access.server.process`, `screen-unavailable.process`, `screen-queued-cancel.process` | `permission-model`, `policy`, `public-failure`, `shutdown-failure`, `computer/physical-input`, daemon `screen-helper-path`, `computer-using` |
| S2.3 | video, stills and recordings over ace-media's wire: `media-source`, `picture-source`, `stream-owners`, `recording`, `session-recording`, `model-capture`, `measurement`                                                                                                                                                                                                                                                                                                                                               | `recording-media.process`, `video-status.process`, `stream-owners`, `measurement.process`; daemon `measurement-step.process`                                                                                                                                                                                                                                                                                                               | `media-backlog.process`, `media-recovery`, `media-source`, `picture-restart.process`, `picture-source`, `picture-view.process`               |

With a built helper present, S2.1 also runs `capture-pacing.native.process` and `helper-identity.native.process`, and S1 runs `computer/uia-engine.native.process` in the Windows VM (each skips without its binary). The † files (`identity.native.process`, `measurement.native.process`, `native.process`, `semantic.native.process`, `media-ingest.native.process`, `media-ingest.linux.process`, `computer/front.native.process`, `computer/background.native.process`) are the owner's run before S1 and S2 go default-on. `index` is the shell.

`ScreenMediaSource` (`media-source.ts:24`–`:32`) keeps its one ordered merge across ace-media
paths and its two stream owners (legacy viewers and ace-media); the Rust side speaks ace-media's
control wire through the `media-wire` crate. `Simulators` (`simulator.ts`) moves in devices D3.1,
not here: it lands in `ace-devices/src/simulators.rs`, and S2.2 uses it from there. If S2.2 lands
first, it calls the TypeScript `Simulators` through a port until D3.1 is merged; there is never a
second Rust copy.

## S3: locked use (needs S1)

| TypeScript replaced (`packages/screen/src/`)                                                                                                                                                                                                                 | Proof: (a) files                                                                                                                                                                                                    | (b) cases to move                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `locked-use`, `locked-use-connection`, `locked-use-handshake` (HMAC-SHA256 with `hmac`, `sha2`, `subtle`), `locked-use-attempt`, `locked-use-detect`, `locked-use-host`, `locked-use-mac`, `locked-use-plist`, `locked-use-wire`, `computer/locked-use-gate` | `locked-use-detect`, `locked-use-host`, `locked-use-mac`, `locked-use-wire`, `locked-use-connection.process`, `computer/locked-use-gate.process`; daemon `locked-use.server.process`, `computer-locked-use.process` | `locked-use-attempt.process`, `locked-use-handshake`, daemon `locked-use-runtime.process`, `locked-use-installer`, `locked-use-privileged` |

Same timeouts (ready 15 s, relock 30 s, `locked-use-attempt.ts:236`, `:284`; status every 60 s,
`locked-use-mac.ts:63`). The privileged install is the owner's to test on a real Mac.
`locked-use-fake-mac` and `testing/` stay TypeScript test support.

### One locked-use authority, in every mix of switches

S3 and S4 have separate switches, so the computer tools can run natively while locked use is still
TypeScript, and the other way round. Whatever the mix, the process has **exactly one** gate and
one locked-use runtime: the gate the daemon builds in `computerLockedUseGate`
(`apps/daemon/src/computer-locked-use.ts:10`–`:33`) from the person's `computer.lockedUse`
setting (read on every call), the runtime's shared protected interval (`intervalActive`,
`runUnprotected`, `runProtected`), the engine's active run for the calling agent (`turn`, the
approved turn, never from tool arguments) and the computer helper's process ids; and the one
revocation, `cancelLockedUseWhenTurnedOff` (`:36`–`:53`), which cancels every queued or running
protected attempt when the person turns locked use off. Never build a second gate, interval or
subscription.

- **S4 on, S3 off.** The native computer tools receive the TypeScript gate as a port and call it
  for every `screen_state` and `screen_act`, exactly where `computerToolkit` does
  (`computer/toolkit.ts:215`–`:217`). The `send` they pass is a JS-callable continuation that
  starts the native helper request synchronously when called, so `runUnprotected` counts it in
  flight from that call and no interval can begin under it (`computer/locked-use-gate.ts:37`–`:40`).
- **S3 on, S4 off.** The native runtime and gate sit behind the TypeScript `LockedUseGate`,
  `LockedUseConnection` and runtime facades, which the daemon wires as today; the TypeScript
  toolkit calls the facade gate, and the settings subscription calls the native `cancelActive`.
- **Both on.** The native gate is called in process by the native tools; the subscription stays
  the daemon's, through the facade.
- **Fail closed in every mix.** After deciding, with nothing awaited before the send, the gate
  checks `intervalActive`: while an interval is queued, running, relocking or faulted, every
  ordinary request is refused with `locked_use_interval_active` and its text from the catalog
  table (`computer/locked-use-gate.ts:110`–`:131`), whatever the setting says. A failure while
  deciding sends the request unprotected, counted in flight, exactly as today.
- **Proof, in all four mixes** (S3 off/on × S4 off/on): `computer/locked-use-gate.process`,
  `locked-use-connection.process`, daemon `computer-locked-use.process`,
  `locked-use.server.process`; S4 does not go default-on before S3 has passed this matrix.

## S4: the tool families (needs S1, S2, MCP M2; the locked-use matrix above)

| Family     | TypeScript replaced (`packages/screen/src/`)                                                                                                                                                                                        | Proof: (a) files                                                                                                                                                                                            | (b) cases to move                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `computer` | `computer/toolkit`, `computer/actions`, `computer/act-log`, `computer/app-notes`, `computer/conditions`, `computer/cowork-steps`, `computer/displays`, `computer/memory`, `computer/outline`, `computer/policy`, `computer/schemas` | `computer/toolkit.process`, `computer/linux.process`; daemon `agent-computer-journey.process`, `screen-agent-access.process`, `acp-screen-bridge.process`, `spade-computer-screen.process`, `computer-name` | `computer/actions`, `computer/outline`, `computer/policy-hosts` |
| `screen`   | `mcp` (`screenToolkit`), `tools`, `tool-schemas`                                                                                                                                                                                    | `mcp.process`, `tools.process`; daemon `screen-mcp.server.process`, `measurement-mcp.server.process`                                                                                                        | none                                                            |

Descriptors come from MCP M1's catalog; input is decided by the Zod port until the
family's typed decoding is pinned by its rejection cases (ADR 0225 §4.2). The 1,568 px and
1.15 MP screenshot bounds and the 1 MiB model image go through ace-media's image process.

## When you are done

- Every (a) file of your item passes alone with the switch on and off (S1, S2 on macOS, Linux and
  the Windows VM); your (b) cases pass in `cargo test -p ace-screen`; `check:daemon-native`
  passes; S2's cross-mode list (the daemon files that restart, for the stored screen switch) passes
  both ways.
- Report: the files run and their results, `bench/computer-world.ts` and `daemon-actions.ts`
  figures off and on, anything in behaviour.md that turned out wrong (with the code that shows
  it), anything you kept TypeScript because it couldn't be reproduced exactly, and the one test
  you added, if any.
