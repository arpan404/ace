# 0011: Screen streaming and computer use

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories describe t3code's desktop browser automation and simulator streaming, Codex and Claude's per-app computer-use approvals, Cursor's desktop takeover and video artifacts, and Antigravity's action recordings. t3code's browser automation needs an Electron host and does not stream desktop applications to remote clients. The inventories are feature references only; no implementation is reused.

ace needs the same local desktop session to be watchable and controllable by desktop, web and mobile clients. The daemon must own capture even when no desktop client exists. Remote transport and MCP infrastructure are separate workstreams, so this package exposes small authenticated connection and tool-handler interfaces.

## Decision

Implement `native/screen-helper` as a macOS 13+ Swift sidecar and `@ace/screen` as its TypeScript owner. Use ScreenCaptureKit and JPEG initially. Each JPEG is independently decodable, so replacing a queued frame cannot break a decoder. H.264 is a future negotiated codec; interframe video would require keyframe-aware dropping and decoder recovery. There is no private CoreSimulator API or provider credential access.

The helper reads bounded newline JSON commands on stdin and writes responses on stdout. Frames travel through a Unix socket inside a mode-0700 temporary directory. One host process handles one active target session and is retained idle under v2. `@ace/provider-kit/process` supervises the process group. Socket closure, malformed frames and process exit fail the session and clear stale screenshots. Restart is explicit and never silently restores agent control.

Session operations include permission inspection, target discovery, start/stop, screenshot, controller selection, input and recording. The manager limits concurrent sessions, subscriptions, outstanding commands and frame size. Dependencies for ids, clocks, process spawning and artifact publication are injected. Simulator discovery and boot use bounded `xcrun simctl` probes; simulator windows use the normal app/window capture path and CGEvent input. `simctl io` has no general documented touch injection command, so it is not used for input.

## Protocol and wire additions

Add schema-only `screen.ts` exports to `@ace/protocol`. Screen messages have their own discriminated union and request ids, separate from durable agent events. The authenticated daemon connection accepts additive `screen.request` messages and sends `screen.result` and `screen.state`. Approval changes are human connection operations; scoped MCP tools cannot approve an app or enable the feature. Frames are binary WebSocket messages, never base64 in the event log.

A binary packet is a four-byte big-endian JSON-header length, a UTF-8 header, then exactly `header.bytes` payload bytes. Headers contain session id, sequence, timestamp, dimensions and codec. Header length is at most 4096 bytes; payload is at most 8 MiB. Unknown helper replies are retained as bounded raw data for diagnostics. Unsupported protocol versions fail explicitly. Clients inspect the same schema and framing as the helper connection.

The capture indicator turns on before dispatching native capture, and startup cancellation publishes its final off state before removing the session. Client state includes a `stopping` lifecycle while helper termination is pending. The capture indicator remains on until native capture stop is acknowledged, or process/socket cleanup is confirmed on failure and disable. Capture termination precedes artifact publication, so a stalled publisher cannot keep capturing. Client state includes lifecycle, target, permissions, controller and a visible capture indicator. Every subscription starts with current state. Frame streams are ephemeral, with no replay. Disconnect removes subscriptions and relinquishes human control. Session discovery supports reconnects; all admin connections receive indicator changes. A human can delegate control to a specific scoped agent id. Agent actions require current agent ownership; human takeover invalidates queued agent actions. Screenshots use the latest JPEG only while the session is live and approved.

## Security

Screen access is off by default. The host human explicitly enables it and approves exact application bundle ids. The helper independently enforces the transmitted allowlist and macOS Screen Recording and Accessibility permissions. Revocation stops affected capture before acknowledging success and clears cached frames. Neither an agent tool nor a target title can grant approval.

Window ids and process ids are resolved from ScreenCaptureKit, not supplied as trusted client identities. App/window targets must belong to an approved bundle id. Display capture includes only approved applications, excluding all other apps even if they appear later. Display targets are view-only. Window pointer hit testing stays inside the captured window, and refuses points overlapped by another window of the approved app. Pointer events use public AppKit-to-CGEvent conversion to retain the target window number when posting to the approved process. Apps without a trustworthy focused Accessibility window can use app capture for control. Input uses target-local coordinates and targets the approved app's process, with bounds and permission checks on every action. Window keyboard input also requires a unique match to the application's focused Accessibility window, so keyboard events cannot reach another window of the approved app. Password managers and System Settings receive no implicit approval; the same exact-bundle approval is required, including in display capture.

The socket is local and private, with only one accepted producer. Control and frame boundaries reject oversized or invalid data. Raw stdout and stderr each have a 64 KiB line cap before newline accumulation, so even an idle helper with no pending command is terminated on overflow. Recordings are opt-in, capped, stored with mode 0600 and published as artifacts; typed text is not written into an action log. The merged remote-access transport requires admin scope for screen operations and indicator subscriptions. Device-token authorization and relay encryption remain transport responsibilities. They must authorize the connection before passing it to the screen bridge. No network listener is added by the native helper.

## Performance

Capture is capped at 30 fps and 3840 by 2160 pixels, with a small ScreenCaptureKit queue. A nonblocking native writer retains at most one pending frame. Frame parsing copies each payload once into a bounded destination; it never concatenates stream history. Fan-out shares a single prepared packet and retains at most one pending frame per subscriber. Slow subscribers receive the latest frame after completing the in-flight send. Subscriber and session counts have fixed caps. Recording uses a writable stream with a bounded pending frame and a byte cap; it cannot stall live viewing. Simulator probes have a shared four-operation concurrency cap.

Add non-gating benchmarks for fragmented decoding, fan-out/backpressure, recording, bounded control output and native socket-writer backpressure, reporting throughput and peak RSS. No wall-clock performance threshold gates tests.

## Testing and operation

Use a real fake-helper process and Unix socket to test request/reply correlation, target approval, denied permissions, controller takeover, crash/restart, fragmented frames and bounded queues. Use local authenticated WebSocket connections to test wire delivery and disconnect cleanup. Test recording bytes through real temporary files. Behavior tests target at least eight meaningful mutations. The owner's later rule defers all tests and mutation runs to merge; current cases are marked not executed.

Build the helper using `native/screen-helper/build.sh`; non-macOS builds print a skip and exit successfully. A macOS integration test checks a dedicated AppKit test window. It skips when macOS or explicit integration opt-in is absent and when Screen Recording permission is unavailable. Permissions are never requested automatically during tests. Document granting Screen Recording and Accessibility to the helper or its launching host, permission denial, relaunch requirements, local coordinates, recording format and recovery.

## Protocol v2 and macOS identity (2026-10-02)

The user reports system-wide lag during Codex computer use and repeated XProtect/syspolicyd activity. This is an observation, not evidence about Codex's implementation or a claim that signing alone eliminates scanning. ace avoids process churn and temporary executables, keeps a stable installed identity, and provides semantic accessibility operations so agents usually inspect a small tree rather than repeatedly requesting screenshots. Runtime comparisons need execution at merge under the owner's static-only rule.

V2 adds `hello` capabilities, typed errors, an `--endpoint` IPC URI, change-driven frame metadata, and `ui.tree`, `ui.find`, `ui.act`. V1 command envelopes and `--socket` remain supported. TypeScript negotiates with a v1-compatible hello, validates v2 capabilities, and falls back only when the helper explicitly lacks negotiation. The shared wire header uses `seq`, `ts`, `scale` and optional `dirtyRects`; legacy clients retain their normalized frame view. IPC endpoints have owner-only access. Windows named pipes and Unix sockets share one endpoint abstraction.

One host owns a long-lived helper. Capture is leased only while viewers, a recording or an agent need pixels; accessibility reads and actions do not spawn helpers. Capture release retains the helper and approved target, and shutdown waits for native capture-stop acknowledgement or process termination before removing the visible indicator. Approval and controller checks remain mandatory for every semantic action; refs cannot select a different approved app implicitly.

ScreenCaptureKit's frame status and dirty rectangles decide whether JPEG encoding runs. Idle samples and empty damage do not encode or transmit. Minimum frame intervals cap active work; GPU sizing happens in SCStreamConfiguration. Missing damage metadata falls back to an in-place bounded fingerprint. UI reads use AXUIElement, bounded batched attribute reads, event-invalidated caches, node/depth/byte caps, and stable refs for the element's lifetime in the host helper, with action validity scoped to the current approved target. Live refs are not silently evicted or reassigned; stale refs fail. Editor text uses AXStringForRange with a 256-character prefix instead of copying an entire AXValue; truncation is explicit. Fresh complete tree caches also serve find queries. Window input resolves current bounds on each action, including after resize. Unsupported semantic actions may use the approved element's centre for input and explicitly report fallback.

The helper is an `.app` bundle with stable `dev.ace.screen-helper` identity. Builds fingerprint source inputs and skip unchanged output. A persisted development signing choice prefers an existing local certificate; ad-hoc is the documented fallback. Unchanged binaries are never re-signed. Installation copies a verified bundle once to the ace data directory; daemon startup never overwrites it. Upgrades are explicit, offline operations. Releases require Developer ID Application signing, hardened runtime, notarization and a stapled ticket, following [Apple's notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

New behavior tests cover negotiation/fallback, endpoint validation, bounded semantic responses, stable refs, approval/takeover, damage filtering, capture leases, stable installation and one child process across 100 actions. Mutation cases and runtime measurements are not executed (tests run at merge). Benchmarks cover idle CPU, changing-window CPU at 10 fps, JPEG latency, large-app `ui.tree` latency and RSS. Historical v1 measurements remain labeled as historical; v2 numbers need run at merge. We do not claim lower CPU or better latency than Codex without measurements.

The shared v2 header also carries `version`, `sessionId` and bounded payload `bytes` for existing framing and target correlation. Mac-only capture lease and metrics commands are optional extensions. Helpers on other platforms need only the shared contract; their integration supplies a supervised spawner, stable installation and an owner-only endpoint factory. The default Windows path fails closed until that factory exists. V1 launchers select explicit legacy socket transport. JPEG remains the only negotiated codec in this implementation.

## Permission identity, Spaces and Simulator input (2026-10-04)

Live diagnosis of the in-app Simulator view (ADR 0064) found four macOS-side causes.

- **Permission attribution.** macOS attributes a child process's privacy checks to its
  responsible process. The daemon is launched by the desktop app, so every Screen Recording and
  Accessibility check of the helper was made for `dev.ace.app`; local app builds are ad-hoc
  signed, so each build voided earlier grants (tccd logged "Failed to match existing code
  requirement"), and the helper's own stable identity never mattered. The helper now
  re-executes itself once at launch with responsibility disclaimed, through libsystem's
  `responsibility_spawnattrs_setdisclaim` (resolved at runtime; without it the helper keeps
  the old attribution and says so on stderr). The child shares stdio and the process group,
  so group supervision and stdin EOF still end it; the parent only mirrors its exit. Grants
  now belong to "Ace Screen Helper" and survive app rebuilds. Development runs from a terminal
  may keep the terminal's grants with `ACE_SCREEN_HELPER_INHERIT_RESPONSIBILITY=1`.
- **Asking for permission.** The helper still never prompts on its own. A new
  `permissions.request` command, sent only for a person's request, calls the system prompt
  once and opens the matching Privacy & Security pane. A grant applies to processes started
  after it, so the manager replaces an idle helper before reading permissions again.
- **Windows on another Space.** Target discovery used on-screen windows only, so a Simulator
  window on another Space (behind a full-screen ace) was invisible. Discovery now includes
  off-screen ordinary titled windows; capture and input look windows up among all shareable
  windows. Window capture uses the display's pixel density (bounded by the existing cap), so
  a phone screen stays legible.
- **Simulator input.** The overlap refusal now counts only windows of the same app stacked in
  front of the target (window-server order), so a second Simulator window behind it no longer
  blocks taps. Keyboard input first clicks the target's title bar, which focuses the window
  without activating the app, then proves the focus as before. Text is sent one key per
  character with its US key code and real Shift key events as well as the Unicode string,
  because Simulator reads hardware keys and ignored the string. Hardware keys no longer use
  menu shortcuts, which reach Simulator only while it is the active app: a new
  `button.press {name}` command presses the captured window's own Accessibility button (Home,
  Rotate, Sleep/Wake), found in the verified focused window, which stays reachable on another
  Space. Every Accessibility call in the helper gives up after one second instead of six, so a
  busy app cannot outlast the command timeout and take the capture down with it. Simulator is
  opened with `open -g` so booting never pulls a person out of ace.
- **Rotation and resizing.** When a window no longer fills the configured frame (Simulator
  rotated, or the window resized), the helper reconfigures the stream to the window's new size
  with `SCStream.updateConfiguration`, at most twice a second. Pixel density comes from the
  window's display mode, which stays valid while NSScreen lists nothing.

Helper installation is versioned: each verified version installs once under
`screen-helper/<version>/`, named for both the executable and Info.plist hashes, beside earlier
ones, never rewriting a running executable. The copy is staged privately and renamed into place,
so a version directory exists only complete and concurrent starts share the winner; startup never
deletes a completed version. Bundles are bounded (256 MiB, 4,096 files).
This replaces "a mismatched installed version requires an explicit upgrade", which made every
new app build fail to open its helper.
