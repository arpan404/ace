# 0011: Screen streaming and computer use

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories describe t3code's desktop browser automation and simulator streaming, Codex and Claude's per-app computer-use approvals, Cursor's desktop takeover and video artifacts, and Antigravity's action recordings. t3code's browser automation needs an Electron host and does not stream desktop applications to remote clients. The inventories are feature references only; no implementation is reused.

ace needs the same local desktop session to be watchable and controllable by desktop, web and mobile clients. The daemon must own capture even when no desktop client exists. Remote transport and MCP infrastructure are separate workstreams, so this package exposes small authenticated connection and tool-handler interfaces.

## Decision

Implement `native/screen-helper` as a macOS 13+ Swift sidecar and `@ace/screen` as its TypeScript owner. Use ScreenCaptureKit and JPEG initially. Each JPEG is independently decodable, so replacing a queued frame cannot break a decoder. H.264 is a future negotiated codec; interframe video would require keyframe-aware dropping and decoder recovery. There is no private CoreSimulator API or provider credential access.

The helper reads bounded newline JSON commands on stdin and writes responses on stdout. Frames travel through a Unix socket inside a mode-0700 temporary directory. One process handles one session. `@ace/provider-kit/process` supervises the process group. Socket closure, malformed frames and process exit fail the session and clear stale screenshots. Restart is explicit and never silently restores agent control.

Session operations include permission inspection, target discovery, start/stop, screenshot, controller selection, input and recording. The manager limits concurrent sessions, subscriptions, outstanding commands and frame size. Dependencies for ids, clocks, process spawning and artifact publication are injected. Simulator discovery and boot use bounded `xcrun simctl` probes; simulator windows use the normal app/window capture path and CGEvent input. `simctl io` has no general documented touch injection command, so it is not used for input.

## Protocol and wire additions

Add schema-only `screen.ts` exports to `@ace/protocol`. Screen messages have their own discriminated union and request ids, separate from durable agent events. The authenticated daemon connection accepts additive `screen.request` messages and sends `screen.result` and `screen.state`. Approval changes are human connection operations; scoped MCP tools cannot approve an app or enable the feature. Frames are binary WebSocket messages, never base64 in the event log.

A binary packet is a four-byte big-endian JSON-header length, a UTF-8 header, then exactly `header.bytes` payload bytes. Headers contain session id, sequence, timestamp, dimensions and codec. Header length is at most 4096 bytes; payload is at most 8 MiB. Unknown helper replies are retained as bounded raw data for diagnostics. Unsupported protocol versions fail explicitly. Clients inspect the same schema and framing as the helper connection.

Client state includes lifecycle, target, permissions, controller and a visible capture indicator. Every subscription starts with current state. Frame streams are ephemeral, with no replay. Disconnect removes subscriptions and relinquishes human control. Session discovery supports reconnects; all human connections receive indicator changes. A human can delegate control to a specific scoped agent id. Agent actions require current agent ownership; human takeover invalidates queued agent actions. Screenshots use the latest JPEG only while the session is live and approved.

## Security

Screen access is off by default. The host human explicitly enables it and approves exact application bundle ids. The helper independently enforces the transmitted allowlist and macOS Screen Recording and Accessibility permissions. Revocation stops affected capture before acknowledging success and clears cached frames. Neither an agent tool nor a target title can grant approval.

Window ids and process ids are resolved from ScreenCaptureKit, not supplied as trusted client identities. App/window targets must belong to an approved bundle id. Display capture includes only approved applications, excluding all other apps even if they appear later. Display targets are view-only. Input uses target-local coordinates and targets the approved app's process, with bounds and permission checks on every action. Window input also requires a unique match to the application's focused Accessibility window, so keyboard events cannot reach another window of the approved app. Password managers and System Settings receive no implicit approval; the same exact-bundle approval is required, including in display capture.

The socket is local and private, with only one accepted producer. Control and frame boundaries reject oversized or invalid data. Recordings are opt-in, capped, stored with mode 0600 and published as artifacts; typed text is not written into an action log. Remote pairing, device-token authorization and relay encryption remain transport responsibilities. They must authorize the connection before passing it to the screen bridge. No network listener is added by the native helper.

## Performance

Capture is capped at 30 fps and 3840 by 2160 pixels, with a small ScreenCaptureKit queue. A nonblocking native writer retains at most one pending frame. Frame parsing copies each payload once into a bounded destination; it never concatenates stream history. Fan-out shares a single prepared packet and retains at most one pending frame per subscriber. Slow subscribers receive the latest frame after completing the in-flight send. Subscriber and session counts have fixed caps. Recording uses a writable stream with a bounded pending frame and a byte cap; it cannot stall live viewing. Simulator probes have a shared four-operation concurrency cap.

Add non-gating benchmarks for fragmented decoding, fan-out/backpressure and recording, reporting throughput and peak RSS. No wall-clock performance threshold gates tests.

## Testing and operation

Use a real fake-helper process and Unix socket to test request/reply correlation, target approval, denied permissions, controller takeover, crash/restart, fragmented frames and bounded queues. Use local authenticated WebSocket connections to test wire delivery and disconnect cleanup. Test recording bytes through real temporary files. Mutate at least eight behavior-bearing production conditions and confirm each mutation fails a test.

Build the helper using `native/screen-helper/build.sh`; non-macOS builds print a skip and exit successfully. A macOS integration test checks a dedicated AppKit test window. It skips when macOS or explicit integration opt-in is absent and when Screen Recording permission is unavailable. Permissions are never requested automatically during tests. Document granting Screen Recording and Accessibility to the helper or its launching host, permission denial, relaunch requirements, local coordinates, recording format and recovery.
