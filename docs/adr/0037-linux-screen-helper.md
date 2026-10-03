# 0037: Linux capture and accessibility helper

Date: 2026-10-02. Status: accepted.

## Context

ADR 0011 owns approval, control ownership, bounded frames and recordings. The supplied competitor inventories describe browser-first automation and desktop capture, but their remote clients depend on a desktop host or cloud worker. Pixel coordinates also break when layouts change. Linux needs a local helper that works without Electron and exposes application accessibility semantics.

## Decision

Build a Rust helper in `native/screen-helper-linux`. Keep a stable installed executable in the ace data directory. One daemon-owned process handles commands and a single active capture; stop releases capture resources, without replacing the executable or spawning tools for input. X11 uses XShm, XDamage, XTest and EWMH. Wayland uses a combined RemoteDesktop and ScreenCast portal session, followed by PipeWire. Never bypass compositor consent through XWayland input. Portal capability discovery, rather than desktop-name guesses, controls advertised support. Restore tokens are private files in the data directory; revoked consent still requires another prompt.

AT-SPI2 runs on its separate accessibility D-Bus. Object bus names and paths identify stable refs, held in a capped cache. Queries and actions stay scoped to the approved application. Traversal has node, depth, reply-byte and time limits. Missing interfaces are ordinary capability differences; dead objects report `target_gone`.

## Protocol and wire additions

Add `screen-v2.ts` schemas and exports, preserving v1 definitions. New helpers accept `--endpoint unix:/path`. The owner creates a mode-0700 directory and mode-0600 socket. Requests and replies remain bounded newline JSON with request ids. `hello` returns version 2 capabilities, platform, capture/input support, semantic actions, codecs and permission states. Typed errors distinguish permission, missing targets, unsupported operations, bounds, busy, timeout and internal faults.

Frames retain the existing big-endian header-length and JPEG payload framing. V2 adds `seq`, `ts`, `scale` and optional dirty rectangles alongside the v1 session fields so the existing recording and fan-out code can keep working. `ui.tree`, `ui.find` and `ui.act` expose bounded accessibility operations. Agent tool descriptions direct agents to inspect the UI tree before using screenshots for visual checks.

Linux backend selection prefers Wayland when `WAYLAND_DISPLAY` is set, otherwise X11 when `DISPLAY` is set. An explicit selection can override this. A missing session fails with a clear headless error. The TypeScript owner validates negotiated capabilities before starting capture or issuing semantic operations.

## Security

Only the local daemon can reach the private frame endpoint. X11 itself has no isolation between clients, so the helper checks application identity, target lifetime, focus and coordinate bounds before input. Whole-display capture requires explicit approval and is view-only. Accessibility refs cannot authorize another application. The Wayland chooser is the final authority on capture scope. Input is advertised only when the portal grants it. Persisting a restore token does not grant new capabilities or remove the compositor's right to prompt again.

The executable is installed once, never rewritten during a session. macOS releases require a stable bundle id, Developer ID signing, hardened runtime and notarization of an app bundle with Info.plist. Windows releases require Authenticode. Development builds use a stable signing identity; build scripts must not repeatedly ad-hoc sign production helpers.

## Performance

Damage notifications wake X11 capture. A pending change coalesces until the fps deadline; unchanged windows produce no frames. PipeWire frames use bounded buffers and content comparison because compositors may deliver repeated frames. JPEG encoding and frame writing have fixed size limits and bounded backpressure. Capture is released on explicit stop and after the last Linux viewer leaves, once queued input drains. Agent delegation and recording retain demand; bootstrap sessions await a viewer or explicit stop. This ends the capture session rather than silently reacquiring portal consent. Accessibility traversal caps work rather than collecting an entire app before pruning. Benchmarks report idle CPU, changing-window CPU, JPEG latency, tree latency and RSS without gating on elapsed time.

## Testing

For this revision, the repository owner requires all tests and benchmarks to run at merge time only. The following verification paths are provided but not executed for the delivered revision.

Run host unit tests for protocol validation, backend choice, portal policy, traversal caps and damage scheduling. Run real Xvfb, a window manager, a GTK app, accessibility bus and the helper in an ephemeral Debian Docker container. Assert capture bytes, damage changes, synthesized input, tree pruning, searches and semantic edits through the public command channel. Delete the test container and image on success or failure. Wayland requires manual GNOME and KDE sessions, including first consent, restore, revocation, window/display selection, scaling and reconnects. Fake helpers test TypeScript negotiation and tool routing without provider CLI access.
