# Screen streaming and computer use

`@ace/screen` owns macOS, Windows and Linux screen sessions without an Electron client. It exposes JPEG streams, human takeover, scoped MCP tools, macOS simulator discovery and bounded recording artifacts. Capture is off by default. The daemon persists the computer use switch in SQLite; controller leases never survive restart. See [Background computer use](../../docs/adr/0067-background-computer-use.md) and the [UI handoff](../../docs/daemon/background-computer-use.md).

## Agent computer use (macOS)

On macOS, agents drive apps through `computerToolkit` (`src/computer/`), not the session
tools below. It registers `screen_apps`, `screen_state` and `screen_act` over a pool of
`ace-screen-helper --computer` processes owned by `ComputerClient`
([ADR 0087](../../docs/adr/0087-background-computer-use-engine.md)): one per target app
(at most six, least recently used idle one evicted, idle ones exit after five minutes) and
one shared helper for `hello`, `apps` and `resolve`. Different apps run in parallel; a hung
app stalls only its own helper.

- Apps launch without activation. Windows on other Spaces are reached through AX remote
  tokens. Nothing posts to the HID stream or moves the cursor; `activate` is the explicit
  step that brings an app forward.
- Observations wait for the UI to settle (AX notifications plus a short quiet interval) and
  return an outline: one line per meaningful element, with ids that stay stable. The
  toolkit keeps each caller's last outline per app and returns a diff, or "No change since
  your last look." (`src/computer/outline.ts`, pure).
- Clicks by id use AX actions (press, focus, select), so they work off-screen; clicks by
  x,y are screenshot pixels hit-tested against the outline. Keys and text are posted to the
  app's process. Menus are pressed by path without opening them.
- Screenshots are window-only, at most 1568 px on the long edge and about 1.15 MP, so the
  model sees them unscaled and its pixel coordinates are the ones the helper uses.
  Actionable elements are tagged with their outline ids on the image.
- Background apps ignore ⌘ shortcuts and have no key window for first-responder commands.
  Before keyboard and menu steps the helper makes the target window the app's key window
  through SkyLight focus records, without activating it (`ComputerFocus.swift`); ⌘
  shortcuts press their menu item; ⌘A/⌘C/⌘X/⌘V and plain paste edit the focused text
  through AX. Rich paste (markdown or HTML) goes through the clipboard, which is restored.
- The person wins: an action refuses while they are using that same app, Esc during agent
  activity stops it, a locked screen is reported, and the display stays awake while acting.
  On visible windows a small marker shows where the agent acts (`ComputerOverlay.swift`).
- Steps (`src/computer/actions.ts`, the source of truth for the action set): click (id or
  x,y, left/right/middle, count, modifiers, hold), move (hover), type, paste, key (repeat,
  hold), set_value, select_text, scroll (pages or pixels), scroll_to, action, menu, focus,
  drag (points or ids, modifiers), window ops, wait, wait_for, activate and `if {text|id, gone?, steps?}`, which runs the next steps only if a
  matching element is there, else the result says they were skipped.
- Password managers, authentication prompts, terminals, script runners (Script Editor,
  Automator, Shortcuts) and ace itself are refused, as are apps the person lists under
  `computer.blockedApps` (`src/computer/policy.ts`, case-insensitive). Permissions are
  otherwise provider-native.

The helper speaks JSON lines on stdin/stdout. Requests are `{id, op, ...}` with `op` one of
`hello` (version, permission facts and capabilities), `apps`, `resolve`, `state`, `act` and
`cancel {target}`; replies are `{id, ok: true, result}` or `{id, ok: false, error: {code,
message}}`, where `message` is written for the model. Replies are parsed leniently
(`src/computer/wire.ts`). Each helper runs one request at a time and answers `cancel` at
once. When a call is aborted or overruns its deadline, the client sends `cancel`, waits a
grace period for the reply (an act reports the steps it finished), then kills only that
app's helper. A reply over the size cap fails its call at once. Helpers start on first use
and restart after they exit.

The session tools and wire described below remain for the person's live view and takeover,
for simulators, and as the agent tools on Windows. On Linux the same `computerToolkit` drives
`ace-screen-helper-linux --computer` ([COMPUTER.md](../../native/screen-helper-linux/COMPUTER.md)).

## Build and enable

On macOS 13 or later:

```sh
native/screen-helper/build.sh
ACE_SCREEN_HELPER="$PWD/native/screen-helper/build/ace-screen-helper" bun run --filter @ace/daemon dev
```

The build skips successfully on other platforms. Set `ACE_SCREEN_HELPER` to the installed helper on macOS or Windows. The helper is an app bundle with stable id `dev.ace.screen-helper`. Builds retain an existing development certificate identity or a persisted ad-hoc fallback, skip unchanged sources, and never re-sign unchanged executable bytes. Startup verifies and installs it once under `<ACE_HOME>/screen-helper/AceScreenHelper.app`; it refuses runtime replacement. Release signing uses Developer ID, hardened runtime and notarization. See [native build and release instructions](../../native/screen-helper/README.md).

In System Settings > Privacy & Security, grant **Screen Recording** for capture and **Accessibility** for input to **Ace Screen Helper**. The macOS helper re-executes itself once with its launcher's responsibility disclaimed, so macOS attributes and remembers these grants for the helper's own signed identity, not for the app or terminal that started the daemon (an ad-hoc signed local app build changes identity on every build, which silently voided grants made to it). `ACE_SCREEN_HELPER_INHERIT_RESPONSIBILITY=1` keeps the launcher's grants for development from a terminal. macOS may call Screen Recording "Screen & System Audio Recording". A grant applies to helper processes started after it; `currentPermissions()` replaces an idle helper before checking. Disabled status checks return no permission grants without starting a helper. ace checks permission state without automatically prompting; `requestPermission()` prompts only when a person asks, then opens the matching System Settings pane. `screen.request` with operation `permissions` reports both permissions. Denial produces a command error, never an automatic retry or an empty successful screenshot.

An authenticated admin turns computer use on. There are no per-app grants: an agent's calls are governed by its provider's own permission mode, using the tools' MCP annotations. Up to eight macOS app/window sessions share one helper, with one exclusive lease per bundle id. Simulator uses an ordinary window session. Each session starts in background mode: AX actions first, then process-posted events. Unsupported background input returns `foreground_required`; the agent can then switch the session to foreground. A controller change returns it to background. Display captures remain view-only.

Occluded windows use desktop-independent ScreenCaptureKit filters. Minimized and off-display windows fail explicitly. For app targets, capture and coordinate input bind to the verified AX focused window; a changed focused window requires selecting a new explicit window target. Window targets are preferred for pixel work. Every action settles the UI and returns a compact AX snapshot. Background focus guards attempt to restore observed target activation or AX focus changes; recent human input suppresses restoration. Menu and popup presses require foreground consent. Clipboard paste restores saved representations unless another writer intervenes. Secure input requires explicit per-session human consent, and secure values stay redacted.

## Daemon wire

The regular daemon WebSocket hello authenticates the device first. Additive requests use:

```json
{
  "type": "screen.request",
  "requestId": "request-1",
  "operation": {
    "op": "start",
    "target": { "kind": "window", "bundleId": "dev.example.App", "windowId": 42 },
    "fps": 10
  }
}
```

Operations are `enable`, `stop.all`, `mode`, `secure.input`, `open.app`, `capabilities`, `ui.tree`, `ui.find`, `ui.act`, `input`, `permissions`, `targets`, `sessions`, `start`, `stop`, `controller`, `action`, `subscribe`, `unsubscribe`, `record.start`, `record.stop`, `simulators` and `simulator.boot`. `start` returns a session state with its id. Distinct apps can remain active concurrently; competing acquisition returns `target_busy` with the holder. `targets` lists display ids and windows with bundle ids. `simulator.boot` boots a known available device and opens Simulator. Then select the simulator window from `targets`.

Replies are `screen.result` with the matching request id, success, data or error. Subscribe to a session for `screen.state` and its live pictures. State reports capture indicator, controller, lifecycle, target, permissions and negotiated capabilities. The indicator turns on before capture dispatch, including during startup. The `stopping` lifecycle rejects input and screenshots while the capture indicator stays visible until native capture-stop acknowledgement or helper termination is confirmed. Artifact publication follows capture stop; a stalled publisher cannot keep capturing. Failure and feature disable wait for owned process cleanup. The client must visibly show the capture indicator while true. `sessions` lists bounded current sessions for reconnects. All connected admin devices receive state changes even without a frame subscription. V2 macOS releases capture after the last viewer, recording or screenshot consumer leaves, retaining the idle helper. Semantic operations hold no pixel lease. Controller ownership for a disconnected connection is released. Legacy v1 capture persists until stop. A disconnected request that finishes starting a new session stops that session immediately.
Live pictures use the one media pipeline (ADR 0011 "One media pipeline"): every binary message is a piece of the stream envelope (`@ace/browser/stream`), and a session's pictures are stream kind 5 `screenFrame`, named by the session id. Each picture carries its sequence, capture time, size, `scale` (pixels per point), rotation, keyframe flag and codec (`jpeg`, or the helper's H.264 as a WebCodecs string), and the capture's stream id (the session id, with the capture generation when the helper restarted it). The viewer acks what it shows with `screen.ack` (cumulative, fire and forget); the daemon keeps at most 8 pictures or 2 MiB unacknowledged per viewer, drops H.264 deltas that don't fit until the next keyframe (asked of the helper at most every 500 ms), and gives a slow JPEG viewer the newest picture when its window opens (`@ace/browser/picture-channel`). Pictures wait while the socket holds more than 128 KiB. Ignore old sequences after reconnect; there is no replay. Frames are capped at 8 MiB, 3840 by 2160 pixels and 30 fps. Clients should heartbeat during viewing using the normal daemon protocol.

Inside the daemon, a helper writes each captured frame to its pipe as a four-byte big-endian header length, the JSON `ScreenFrameHeader`, then `header.bytes` payload bytes; `FrameDecoder` reads that pipe and normalizes v1/v2 sequences and timestamps. That framing never reaches a client.

Human input requires ownership of the session's human controller on that connection. V2 pointer and scroll coordinates are target-window points; app targets use their verified focused window. Prefer a window target for pixel coordinate work. Window point input and keyboard focus checks use current geometry after move or resize. V1 actions retain screenshot-pixel coordinates and macOS virtual key codes. V2 input supports pointer move/click/drag, named keys with command/shift/option/control modifiers, whole-string Unicode text and scrolling. Display streams cannot inject input. Every action checks that computer use is still on, controller ownership and macOS permissions again. Takeover invalidates queued actions; an already dispatched native action may finish. Input queues hold at most sixteen actions per session, with one dispatched at a time.

## Package and MCP API

Instantiate `ScreenManager` with helper command, injected id generator, artifact directory and artifact publisher, or use `localScreenManager` at the daemon boundary. Pass a manager as the optional seventh argument to `startDaemon`, after MCP toolkits, notification channels, model instances and the diagnostics workload callback, or through `ServerOptions.screen`. `screenConnection` takes an authenticated transport's JSON sender and its media transport (one binary message per stream piece, and the backlog), and returns `request`, `ack` and `close`, so the local socket and the encrypted relay share it.

The daemon registers lazy descriptors through `screenToolkit(manager)`. Agent tools are `screen_open_app`, `screen_windows`, `screen_ui_tree`, `screen_ui_act`, `screen_input`, `screen_screenshot` and `screen_measure`. The provider MCP lease must include the `screen` capability. `screen_open_app` launches an app without activation and acquires a session; called again with `windowId` it switches window (restarting capture on the requested window when native selection is unavailable, which returns a replacement session ID), with `url` it opens a deep link, and with `mode` it switches background or foreground input. Session tools accept an optional `sessionId`; it is required when the caller controls several sessions. Selecting another agent's session fails. Read and action results report mode; actions return settled snapshots.

An admin can delegate with `controller: "agent"`, `threadId` and `agentId`, or `manager.delegateAgent(sessionId, {threadId, agentId})`. Both IDs must match the MCP credential. Per-session human takeover invalidates queued input. `stop.all` cancels pending starts, clears all controllers and blocks agent reacquisition until a person sends `enable:true`. `computerUseHandler(manager, sessionId, owner)` remains the directly scoped handler API. Screenshots use the separate 12 MiB rich-result cap; live video uses binary transport.

`record.start` saves JPEG frames to a private `.ace-screen` file, in the helper pipe's framing, readable with `FrameDecoder`. It preserves timestamps and sequence gaps when disk backpressure drops frames. Stop drains the in-flight and latest queued packet and publishes an artifact capped at 50 MiB. The local publisher saves an adjacent JSON manifest under the daemon's `screen-artifacts` directory; another artifact service can replace the publisher. Recordings contain screenshots, not a typed-text action log. They are not MP4 files. On crashes, complete received packets are finalized as an artifact. Quota and retention across multiple recordings belong to the artifact service.

A helper failure clears the last screenshot, subscriptions and controller ownership, reports failed state and removes the session after capture cleanup. An agent can explicitly reacquire its app or replace an ownerless session. Per-request timeouts and native capture failures remain isolated from other sessions. Restarts never silently restore agent control. All process groups and Unix sockets are released on close.

Stopping capture reports `stopping` until native acknowledgement or process exit, then turns the indicator off before publishing the recording. Publication failure still closes the helper during daemon shutdown. Reaching a recording cap or failing a frame subscriber releases capture demand immediately. Only one recording publication may be pending per session.

## Verification

Run affected process tests serially on the shared machine. Native tests use disposable fixtures and require explicit live-test authorization plus existing OS permissions. Never operate user documents. Build with `native/screen-helper/build.sh`; native decision tests run through `swift test --package-path native/screen-helper`. Run static checks and regenerate protocol docs before delivery. Native compatibility, locked-Mac capture and foreground restoration need the owner's live verification.

Normal tests use real supervised fake-helper processes, private Unix sockets, temporary recording files and authenticated local WebSockets. The opt-in macOS test builds a dedicated AppKit window, confirms native allowlist denial, receives real window and app JPEG frames, and verifies Unicode text, mouse clicks, keys and scroll movement or native Accessibility denial. It skips if Screen Recording is unavailable; no test prompts for permissions or runs provider CLIs.

Primary API references: [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), [SCStreamOutput](https://developer.apple.com/documentation/screencapturekit/scstreamoutput), [Accessibility trust](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrusted), and the installed `xcrun simctl help` command. See [ADR 0011](../../docs/adr/0011-screen-and-computer-use.md).

Helper stdout and stderr are capped at 64 KiB per line before readline accumulates or decodes bytes. Overflow terminates the owned helper, including when no command is pending. `HelperOptions.scheduler` accepts a cancelable deadline scheduler for deterministic tests. The default scheduler uses Node timers at the I/O boundary.

## V2 semantic access and compatibility

`hello` negotiates v2 capabilities and typed errors. `ui.tree` accepts depth 0–16 and 1–512 total nodes; `ui.find` searches up to 512 nodes without shipping the full tree and returns up to 64 matches. Both enforce a byte budget and report truncation. Text values use a bounded 256-character accessibility range; editor documents are never requested as whole values. Fresh complete tree caches also serve find queries. Nodes contain stable refs, role/name, optional value/description, global accessibility point bounds, states, supported actions and children. Secure-field values are redacted and agent input requires per-session human consent. Native semantic actions return `fallback: false`; only unsupported platform actions may synthesize input at the target's bounds and return `fallback: true`. Missing, destroyed or out-of-scope refs fail with `target_gone`.

One manager owns one host helper and up to eight macOS target sessions, exclusive by application identity. Concurrent inspections reuse that process. Capture lease changes coalesce while one native command is in flight; screenshot waiters use the acknowledged sequence floor to exclude queued frames from previous leases. Caps include 32 helper requests, 16 input actions, 16 screenshot waiters, 80 pixel leases, 64 viewers, 64 state listeners and 4096 native refs. Trees cache one bounded snapshot for 250 ms and invalidate on AX notifications. No idle refresh timer runs.

`HelperOptions.transport: "legacy"` launches old helpers with `--socket`; the default uses v2 `--endpoint`. A v1-compatible hello falls back only when unsupported. Legacy helper frame headers and `action` remain accepted on the helper pipe. `ScreenManager` accepts injected endpoint preparation, process spawning and stable installation through `HelperOptions`; `localScreenManager` is the macOS convenience shell. Linux and Windows integrate their helpers through those seams. Windows requires its workstream's owner-only pipe factory and supervised spawner; the default fails closed because Node's default pipe ACL cannot guarantee owner-only access. Mac-only `capture {enabled}` and `metrics` are optional extensions, not requirements of the shared v2 contract.

The non-gating `bench/native-runtime.ts` measures idle helper CPU, changing-window CPU at 10 fps, mean encode latency, cold and cached large-app tree latency, and peak RSS. Configure already built helper/fixture paths through `ACE_SCREEN_BENCH_HELPER` and `ACE_SCREEN_BENCH_FIXTURE`; the large app defaults to Finder. Explicitly select another app through `ACE_SCREEN_BENCH_BUNDLE`. Native measurements require a separately authorized live run.

## Windows and protocol v2

Windows uses the Rust helper in [native/screen-helper-windows](../../native/screen-helper-windows/README.md). Runtime behaviour on real Windows is untested. The daemon resolves its stable install path through `screenHelperPath`, negotiates `hello` capabilities, and connects to a helper-owned named pipe with an owner-only DACL. One helper stays alive across inspections and screen sessions. Windows currently supports one active window or monitor target, and pauses native capture when no viewers, recordings or actions need it. The Swift helper negotiates v2 with background and multi-session capabilities. Windows and Linux retain their current single-target helpers; background agent input fails closed pending the ADR 0067 follow-up.

Additive protocol schemas live in `screen-v2.ts` and `screen-ui.ts`. v2 helper frames preserve seq, ts and pixels-per-point scale; FrameDecoder normalizes the sequence/timestamp aliases and keeps the helper's bytes for recording. Windows commands and packets carry `captureGeneration` to discard retired in-flight frames across pause/resume and target changes. A fresh screenshot after resume requires the current generation. Windows targets are exact lowercase executable paths from target inventory; whole-monitor viewing targets `monitor:<displayId>`. It cannot redact other apps on that monitor.

`screen_ui_tree` reads the tree, or finds elements when given `role`, `name` or `text`; `screen_ui_act` acts on a stable ref or presses a menu path. Inspect the tree first, act through stable refs and use screenshots for visual checks. Tree bounds and `screen_input` use target-local points; divide screenshot pixels by the reported scale. `screen_input` takes portable key names; it requires a helper that negotiates protocol v2, which every helper ace ships does. UI reads check session ownership; semantic actions use the same serialized controller checks as input. The authenticated screen bridge also accepts capabilities, ui.tree, ui.find and ui.act operations.

Host tests cover v2 negotiation, fragmented frames, typed errors, process reuse, capture suspension/resume, semantic state changes, takeover and crash recovery. The native README lists build/signing instructions and the exact Windows manual verification and measurement plan. No real Windows CPU, UIA or input results are claimed.

## Linux

Linux uses the installed helper in `native/screen-helper-linux`, in Wayland sessions only ([ADR 0049](../../docs/adr/0049-linux-screen-helper.md)): an X11 session is refused with a sentence asking for a Wayland login, and a missing session fails closed. Portal consent and restore tokens remain compositor-controlled; AT-SPI refs remain application scoped. Linux closes capture after its last viewer leaves and queued input drains, unless agent delegation or recording retains it. The helper stays alive for inspections and subsequent captures. Linux uses the same daemon service and admin authorization boundary as the other platforms. The agent engine on Linux is described in [COMPUTER.md](../../native/screen-helper-linux/COMPUTER.md).
