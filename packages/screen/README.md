# Screen streaming and computer use

`@ace/screen` owns macOS and Linux screen sessions without an Electron client. It exposes JPEG streams, human takeover, scoped MCP handlers, simulator discovery and bounded recording artifacts. Capture is off by default and approvals last for this daemon lifetime.

## Build and enable

On macOS 13 or later:

```sh
native/screen-helper/build.sh
ACE_SCREEN_HELPER="$PWD/native/screen-helper/build/ace-screen-helper" bun run --filter @ace/daemon dev
```

The build skips successfully on other platforms. For Linux, see [`native/screen-helper-linux`](../../native/screen-helper-linux/README.md). Set `ACE_SCREEN_HELPER` to the installed binary. The binary is ad-hoc signed with identity `dev.ace.screen-helper`; packaged releases should use a stable signing identity.

In System Settings > Privacy & Security, grant **Screen Recording** for capture and **Accessibility** for input to the helper or the launching host macOS identifies. macOS may call Screen Recording "Screen & System Audio Recording". Permissions can require quitting and restarting the daemon after a grant. ace checks permission state without automatically prompting. `screen.request` with operation `permissions` reports both permissions. Denial produces a command error, never an automatic retry or an empty successful screenshot.

A human authenticated connection must send `enable`, then `approve` for an exact bundle id. Password managers and System Settings have no implicit approval. Display captures include only the explicitly selected, approved bundle ids and are view-only. Windows without a bundle identity cannot be selected. Window input requires that window to be the application's focused window, verified using public Accessibility bounds; ambiguous matches are refused. If an app does not expose a focused Accessibility window, use app capture for control; window capture still works for viewing. App mode sends keyboard input to the app's current focus and routes pointer input to its window at the selected pixel. Background controls follow the app's normal first-click behavior. Input can affect the app's UI and should be handed back with `controller: "human"` or `"none"` when the human needs it.

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

Operations are `enable`, `approve`, `permissions`, `targets`, `sessions`, `start`, `stop`, `controller`, `action`, `subscribe`, `unsubscribe`, `record.start`, `record.stop`, `simulators` and `simulator.boot`. `start` returns a session state with its id. Choose a new target by stopping the old session and starting another. `targets` lists display ids and windows with bundle ids. Approve `com.apple.iphonesimulator` before `simulator.boot`, which boots a known available device and opens Simulator. Then select the simulator window from `targets`.

Replies are `screen.result` with the matching request id, success, data or error. Subscribe to a session for `screen.state` and binary frames. State reports capture indicator, controller, lifecycle, target and permissions. The client must visibly show the capture indicator while true. `sessions` lists bounded current sessions for reconnects. All connected human devices receive state changes even without a frame subscription. Capture persists across viewer disconnects; controller ownership for that connection is released. A disconnected request that finishes starting a new session stops that session immediately.

Each WebSocket binary message is one complete packet. The first four bytes are a big-endian header length, followed by the JSON `ScreenFrameHeader`, followed by `header.bytes` JPEG bytes. Headers include session id, sequence, timestamp in milliseconds, dimensions and codec. Use exported `FrameDecoder` for fragmented byte streams. Ignore old sequences after reconnect; there is no event-log replay for frames. Frames are capped at 8 MiB, 3840 by 2160 pixels and 30 fps. A slow viewer holds one in-flight frame and one newest pending frame. The daemon disconnects a socket whose existing write backlog exceeds 8 MiB. Clients should heartbeat during viewing using the normal daemon protocol.

Human input requires ownership of the session's human controller on that connection. Screenshot pixels are the coordinate space for click and scroll. Keys use macOS virtual key codes and explicit command, shift, option or control modifiers. Display streams cannot inject input. Every action checks approvals and macOS permissions again. Takeover invalidates queued actions; an already dispatched native action may finish. Input queues hold at most sixteen actions per session, with one dispatched at a time.

## Package and MCP API

Instantiate `ScreenManager` with helper command, injected id generator, artifact directory and artifact publisher, or use `localScreenManager` at the daemon boundary. Pass a manager as the optional sixth argument to `startDaemon` (after model instances), or through `ServerOptions.screen`. `screenConnection` also accepts an authenticated transport's JSON sender and asynchronous binary sender, allowing the remote-access and encrypted-relay workstreams to reuse it.

`computerUseTools` contains JSON schemas for `screen_ui_tree`, `screen_ui_find`, `screen_ui_act`, `screen_screenshot`, `screen_click`, `screen_type`, `screen_key` and `screen_scroll`. `computerUseHandler(manager, sessionId, owner)` is an MCP-compatible handler scoped to a host-selected session and agent owner. A human can delegate through `controller` with `controller: "agent"` and `agentId` matching the scoped agent owner. The MCP host can also grant agent control with that same owner after human approval. Tool arguments cannot change the session, approve applications or enable access. Screenshots return a bounded MCP image; live video uses binary transport. The MCP host must bind the handler to an approved session and authenticated agent owner; registering a global unscoped computer-use handler is unsafe.

`record.start` saves JPEG packets to a private `.ace-screen` file. The format is the same binary packet stream, playable with `FrameDecoder` and any JPEG viewer. It preserves timestamps and sequence gaps when disk backpressure drops frames. Stop drains the in-flight and latest queued packet and publishes an artifact capped at 50 MiB. The local publisher saves an adjacent JSON manifest under the daemon's `screen-artifacts` directory; another artifact service can replace the publisher. Recordings contain screenshots, not a typed-text action log. They are not MP4 files. On crashes, complete received packets are finalized as an artifact. Quota and retention across multiple recordings belong to the artifact service.

A helper failure clears the last screenshot, subscriptions and controller ownership, and reports failed state. Stop the failed session and explicitly start a replacement. Restarts never silently restore agent control. All process groups and Unix sockets are released on close.

## Linux protocol v2

Linux uses a private Unix endpoint and negotiates `hello` capabilities before capture. The daemon keeps one helper alive through inspections and sequential capture sessions. `linuxBackend()` prefers Wayland over XWayland and detects headless sessions; `installedLinuxHelper(dataDir, arch)` resolves a stable installed binary. `ACE_SCREEN_BACKEND=x11|wayland` explicitly selects an available session.

Use the UI tree first, search for controls with `screen_ui_find`, then invoke semantic actions by stable ref. V2 named keys use `{ key: "Enter", modifiers: ["control"] }`; legacy virtual key codes remain macOS-only. Pixel clicks use the latest frame's scale to map back to target points. The v1 macOS helper remains supported.

Remote device scopes apply to every screen request: `admin` is required for enable/approval, `read` for viewing, and `operate` for capture/control. Input still requires session controller ownership and prior application approval. See the native README for chooser identity limits and manual GNOME/KDE verification.

## Verification

Owner instruction for this revision: tests, mutations, benchmarks and native integration are **not executed (tests run at merge)**. The commands below are for merge-time verification. Static checks use typecheck, lint, formatting, file-size checks and cargo check.

```sh
bun run test packages/screen apps/daemon/src/screen.server.test.ts
ACE_SCREEN_INTEGRATION=1 bun run test packages/screen/src/native.test.ts
bun run --filter @ace/screen bench
native/screen-helper/bench.sh
bun run check
```

Normal tests use real supervised fake-helper processes, private Unix sockets, temporary recording files and authenticated local WebSockets. The opt-in macOS test builds a dedicated AppKit window, confirms native allowlist denial, receives real window and app JPEG frames, and verifies Unicode text, mouse clicks, keys and scroll movement or native Accessibility denial. It skips if Screen Recording is unavailable; no test prompts for permissions or runs provider CLIs.

Primary API references: [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), [SCStreamOutput](https://developer.apple.com/documentation/screencapturekit/scstreamoutput), [Accessibility trust](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrusted), and the installed `xcrun simctl help` command. See [ADR 0011](../../docs/adr/0011-screen-and-computer-use.md).
