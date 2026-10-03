# Screen streaming and computer use

`@ace/screen` owns macOS and Windows screen sessions without an Electron client. It exposes JPEG streams, human takeover, scoped MCP tools, macOS simulator discovery and bounded recording artifacts. Capture is off by default and approvals last for this daemon lifetime.

## Build and enable

On macOS 13 or later:

```sh
native/screen-helper/build.sh
ACE_SCREEN_HELPER="$PWD/native/screen-helper/build/ace-screen-helper" bun run --filter @ace/daemon dev
```

The build skips successfully on other platforms. Set `ACE_SCREEN_HELPER` to the installed helper on macOS or Windows. The helper is an app bundle with stable id `dev.ace.screen-helper`. Builds retain an existing development certificate identity or a persisted ad-hoc fallback, skip unchanged sources, and never re-sign unchanged executable bytes. Startup verifies and installs it once under `<ACE_HOME>/screen-helper/AceScreenHelper.app`; it refuses runtime replacement. Release signing uses Developer ID, hardened runtime and notarization. See [native build and release instructions](../../native/screen-helper/README.md).

In System Settings > Privacy & Security, grant **Screen Recording** for capture and **Accessibility** for input to the helper or the launching host macOS identifies. macOS may call Screen Recording "Screen & System Audio Recording". Permissions can require quitting and restarting the daemon after a grant. ace checks permission state without automatically prompting. `screen.request` with operation `permissions` reports both permissions. Denial produces a command error, never an automatic retry or an empty successful screenshot.

An authenticated connection with the remote-access `admin` scope must send `enable`, then `approve` for an exact bundle id. Password managers and System Settings have no implicit approval. Display captures include only the explicitly selected, approved bundle ids and are view-only. Windows without a bundle identity cannot be selected. Window pointer events carry the captured window number and refuse points overlapped by another window of the application. Window keyboard input requires that window to be the application's focused window, verified using public Accessibility bounds; ambiguous matches are refused. If an app does not expose a focused Accessibility window, use app capture for keyboard control. App mode sends keyboard input to the app's current focus and routes pointer input to its window at the selected pixel. Background controls follow the app's normal first-click behavior. Input can affect the app's UI and should be handed back with `controller: "human"` or `"none"` when the human needs it.
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

Operations are `enable`, `approve`, `capabilities`, `ui.tree`, `ui.find`, `ui.act`, `input`, `permissions`, `targets`, `sessions`, `start`, `stop`, `controller`, `action`, `subscribe`, `unsubscribe`, `record.start`, `record.stop`, `simulators` and `simulator.boot`. `start` returns a session state with its id. Choose a new target by stopping the old session and starting another. `targets` lists display ids and windows with bundle ids. Approve `com.apple.iphonesimulator` before `simulator.boot`, which boots a known available device and opens Simulator. Then select the simulator window from `targets`.

Replies are `screen.result` with the matching request id, success, data or error. Subscribe to a session for `screen.state` and binary frames. State reports capture indicator, controller, lifecycle, target, permissions and negotiated capabilities. The indicator turns on before capture dispatch, including during startup. The `stopping` lifecycle rejects input and screenshots while the capture indicator stays visible until native capture-stop acknowledgement or helper termination is confirmed. Artifact publication follows capture stop; a stalled publisher cannot keep capturing. Failure and feature disable wait for owned process cleanup. The client must visibly show the capture indicator while true. `sessions` lists bounded current sessions for reconnects. All connected admin devices receive state changes even without a frame subscription. V2 macOS releases capture after the last viewer, recording or screenshot consumer leaves, retaining the idle helper. Semantic operations hold no pixel lease. Controller ownership for a disconnected connection is released. Legacy v1 capture persists until stop. A disconnected request that finishes starting a new session stops that session immediately.
Each WebSocket binary message is one complete packet. The first four bytes are a big-endian header length, followed by the JSON `ScreenFrameHeader`, followed by `header.bytes` JPEG bytes. V1 headers include session id, sequence, timestamp in milliseconds, dimensions and codec. V2 headers use `seq`, `ts`, `scale` and optional `dirtyRects`, plus `sessionId`, `version` and payload `bytes`. Raw packets are forwarded without translation or reserialization. `FrameDecoder` normalizes v1/v2 sequences and timestamps while preserving scale and damage metadata. Use exported `FrameDecoder` for fragmented byte streams. Ignore old sequences after reconnect; there is no event-log replay for frames. Frames are capped at 8 MiB, 3840 by 2160 pixels and 30 fps. A slow viewer holds one in-flight frame and one newest pending frame. The daemon disconnects a socket whose existing write backlog exceeds 8 MiB. Clients should heartbeat during viewing using the normal daemon protocol.

Human input requires ownership of the session's human controller on that connection. V2 pointer and scroll coordinates are target-window points; app targets use their verified focused window. Prefer a window target for pixel coordinate work. Window point input and keyboard focus checks use current geometry after move or resize. V1 actions retain screenshot-pixel coordinates and macOS virtual key codes. V2 input supports pointer move/click/drag, named keys with command/shift/option/control modifiers, whole-string Unicode text and scrolling. Display streams cannot inject input. Every action checks approvals and macOS permissions again. Takeover invalidates queued actions; an already dispatched native action may finish. Input queues hold at most sixteen actions per session, with one dispatched at a time.

## Package and MCP API

Instantiate `ScreenManager` with helper command, injected id generator, artifact directory and artifact publisher, or use `localScreenManager` at the daemon boundary. Pass a manager as the optional seventh argument to `startDaemon`, after MCP toolkits, notification channels, model instances and the diagnostics workload callback, or through `ServerOptions.screen`. `screenConnection` also accepts an authenticated transport's JSON sender and asynchronous binary sender, allowing the remote-access and encrypted-relay workstreams to reuse it.

`computerUseTools` contains JSON schemas for `screen_ui_tree`, `screen_ui_find`, `screen_ui_act`, `screen_screenshot`, `screen_click`, `screen_type`, `screen_key` and `screen_scroll`. Descriptions direct agents to accessibility first and screenshots for visual checks. `computerUseHandler(manager, sessionId, owner)` is an MCP-compatible handler scoped to a host-selected session and agent owner. A human can delegate through `controller` with `controller: "agent"` and `agentId` matching the scoped agent owner. The MCP host can also grant agent control with that same owner after human approval. Tool arguments cannot change the session, approve applications or enable access. Screenshots return a bounded MCP image; live video uses binary transport. These definitions are ready for registration by the separate MCP server workstream.
Instantiate `ScreenManager` with helper command, injected id generator, artifact directory and artifact publisher, or use `localScreenManager` at the daemon boundary. Pass a manager as the optional seventh argument to `startDaemon`, after model instances and diagnostics workload, or through `ServerOptions.screen`. `screenConnection` also accepts an authenticated transport's JSON sender and asynchronous binary sender, allowing the remote-access and encrypted-relay workstreams to reuse it.

The daemon automatically registers `screen_screenshot`, `screen_click`, `screen_type`, `screen_key`, `screen_scroll`, `screen_ui_tree`, `screen_ui_find` and `screen_ui_act` through `screenToolkit(manager)`. The provider MCP lease must include the `screen` capability. An authenticated admin delegates through `controller` with `controller: "agent"`, `threadId` and `agentId`, or calls `manager.delegateAgent(sessionId, {threadId, agentId})`. Both IDs must match the MCP credential; reusing an agent ID in another thread grants no access. The legacy agentId-only controller API remains available for directly scoped handlers, but grants no MCP delegation. `computerUseHandler(manager, sessionId, owner)` remains the direct handler API. Tool arguments cannot change the session, approve applications or enable access. Screenshots return an MCP JPEG image within the separate 12 MiB rich-result cap; live video uses binary transport.

`record.start` saves JPEG packets to a private `.ace-screen` file. The format is the same binary packet stream, playable with `FrameDecoder` and any JPEG viewer. It preserves timestamps and sequence gaps when disk backpressure drops frames. Stop drains the in-flight and latest queued packet and publishes an artifact capped at 50 MiB. The local publisher saves an adjacent JSON manifest under the daemon's `screen-artifacts` directory; another artifact service can replace the publisher. Recordings contain screenshots, not a typed-text action log. They are not MP4 files. On crashes, complete received packets are finalized as an artifact. Quota and retention across multiple recordings belong to the artifact service.

A helper failure clears the last screenshot, subscriptions and controller ownership, and reports failed state. Stop the failed session and explicitly start a replacement. Restarts never silently restore agent control. All process groups and Unix sockets are released on close.

Stopping capture reports `stopping` until native acknowledgement or process exit, then turns the indicator off before publishing the recording. Publication failure still closes the helper during daemon shutdown. Reaching a recording cap or failing a frame subscriber releases capture demand immediately. Only one recording publication may be pending per session.

## Verification at merge

The repo owner requires tests, benchmarks and mutation runs to wait until merge. Only static checks have been run on this final Windows revision.

The owner currently permits only `bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run check:size` and `swift build` for native compilation. Do not run tests, probes, mutation scripts or benchmarks during this workstream. All runtime outcomes and measurements need run at merge. The following commands are for merge-time validation only:

```sh
bun run test packages/screen apps/daemon/src/screen.server.test.ts
ACE_SCREEN_INTEGRATION=1 bun run test packages/screen/src/native.test.ts packages/screen/src/semantic.native.test.ts
bun run --filter @ace/screen bench
native/screen-helper/bench.sh
sh native/screen-helper/bench-writer.sh
node packages/screen/bench/control-output.ts
bun run check
swift test --package-path native/screen-helper
```

Normal tests use real supervised fake-helper processes, private Unix sockets, temporary recording files and authenticated local WebSockets. The opt-in macOS test builds a dedicated AppKit window, confirms native allowlist denial, receives real window and app JPEG frames, and verifies Unicode text, mouse clicks, keys and scroll movement or native Accessibility denial. It skips if Screen Recording is unavailable; no test prompts for permissions or runs provider CLIs.

Primary API references: [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), [SCStreamOutput](https://developer.apple.com/documentation/screencapturekit/scstreamoutput), [Accessibility trust](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrusted), and the installed `xcrun simctl help` command. See [ADR 0011](../../docs/adr/0011-screen-and-computer-use.md).

Helper stdout and stderr are capped at 64 KiB per line before readline accumulates or decodes bytes. Overflow terminates the owned helper, including when no command is pending. `HelperOptions.scheduler` accepts a cancelable deadline scheduler for deterministic tests. The default scheduler uses Node timers at the I/O boundary.

## V2 semantic access and compatibility

`hello` negotiates v2 capabilities and typed errors. `ui.tree` accepts depth 0–16 and 1–512 total nodes; `ui.find` searches up to 512 nodes without shipping the full tree and returns up to 64 matches. Both enforce a byte budget and report truncation. Text values use a bounded 256-character accessibility range; editor documents are never requested as whole values. Fresh complete tree caches also serve find queries. Nodes contain stable refs, role/name, optional value/description, global accessibility point bounds, states, supported actions and children. Secure-field values are redacted and semantic input to secure fields is refused. Native semantic actions return `fallback: false`; only unsupported platform actions may synthesize input at approved bounds and return `fallback: true`. Missing, destroyed or out-of-scope refs fail with `target_gone`.

One manager owns one host helper and one active target session. Concurrent inspections reuse that process. Capture lease changes coalesce while one native command is in flight; screenshot waiters use the acknowledged sequence floor to exclude queued frames from previous leases. Caps include 32 helper requests, 16 input actions, 16 screenshot waiters, 80 pixel leases, 64 viewers, 64 state listeners and 4096 native refs. Trees cache one bounded snapshot for 250 ms and invalidate on AX notifications. No idle refresh timer runs.

`HelperOptions.transport: "legacy"` launches old helpers with `--socket`; the default uses v2 `--endpoint`. A v1-compatible hello falls back only when unsupported. Legacy frame packets and `action` remain accepted. `ScreenManager` accepts injected endpoint preparation, process spawning and stable installation through `HelperOptions`; `localScreenManager` is the macOS convenience shell. Linux and Windows integrate their helpers through those seams. Windows requires its workstream's owner-only pipe factory and supervised spawner; the default fails closed because Node's default pipe ACL cannot guarantee owner-only access. Mac-only `capture {enabled}` and `metrics` are optional extensions, not requirements of the shared v2 contract.

The non-gating `bench/native-runtime.ts` measures idle helper CPU, changing-window CPU at 10 fps, mean encode latency, cold and cached large-app tree latency, and peak RSS. Configure already built helper/fixture paths through `ACE_SCREEN_BENCH_HELPER` and `ACE_SCREEN_BENCH_FIXTURE`; the large app defaults to Finder. Explicitly select another approved app through `ACE_SCREEN_BENCH_BUNDLE`. Measurements are deferred under the owner's rule.

## Windows and protocol v2

Windows uses the Rust helper in [native/screen-helper-windows](../../native/screen-helper-windows/README.md). Runtime behaviour on real Windows is untested. The daemon resolves its stable install path through `screenHelperPath`, negotiates `hello` capabilities, and connects to a helper-owned named pipe with an owner-only DACL. One helper stays alive across inspections and screen sessions. Windows currently supports one active window or monitor target, and pauses native capture when no viewers, recordings or actions need it. The existing Swift helper remains on v1 by default.

Additive protocol schemas live in `screen-v2.ts` and `screen-ui.ts`. v2 JPEG packets preserve seq, ts and pixels-per-point scale; FrameDecoder normalizes the sequence/timestamp aliases for existing consumers and keeps the original packet for transport and recording. Windows commands and packets carry `captureGeneration` to discard retired in-flight frames across pause/resume and target changes. A fresh screenshot after resume requires the current generation. Windows approves exact lowercase executable paths from target inventory; whole-monitor viewing requires `monitor:<displayId>` approval. It cannot redact other apps on that monitor.

The scoped agent tools now include `screen_ui_tree`, `screen_ui_find` and `screen_ui_act`. Inspect the tree first, act through stable refs and use screenshots for visual checks. Tree bounds and v2 input use target-local points; divide screenshot pixels by the reported scale. `screen_key` accepts portable key names on v2 and retains legacy macOS keyCode support. UI reads check session ownership; semantic actions use the same serialized controller and approval checks as input. The authenticated screen bridge also accepts capabilities, ui.tree, ui.find and ui.act operations.

Host tests cover v2 negotiation, fragmented frames, typed errors, process reuse, capture suspension/resume, semantic state changes, takeover and crash recovery. The native README lists build/signing instructions and the exact Windows manual verification and measurement plan. No real Windows CPU, UIA or input results are claimed.

## Linux

Linux uses the installed helper in `native/screen-helper-linux`, with Wayland preferred over XWayland when both displays exist. `ACE_SCREEN_BACKEND` selects x11 or wayland explicitly. A missing session fails closed. Portal consent and restore tokens remain compositor-controlled; AT-SPI refs remain application scoped. Linux closes capture after its last viewer leaves and queued input drains, unless agent delegation or recording retains it. The helper stays alive for inspections and subsequent captures. Linux uses the same daemon service and admin authorization boundary as the other platforms. See [the Linux helper verification plan](../../native/screen-helper-linux/VERIFICATION.md).
