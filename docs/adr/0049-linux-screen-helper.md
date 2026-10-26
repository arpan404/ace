# 0049: Linux capture and accessibility helper

Date: 2026-10-02. Status: accepted.

## Context

ADR 0011 owns approval, control ownership, bounded frames and recordings. The supplied competitor inventories describe browser-first automation and desktop capture, but their remote clients depend on a desktop host or cloud worker. Pixel coordinates also break when layouts change. Linux needs a local helper that works without Electron and exposes application accessibility semantics.

## Decision

Build a Rust helper in `native/screen-helper-linux`. Keep a stable installed executable in the ace data directory. One daemon-owned process handles commands and a single active capture; stop releases capture resources, without replacing the executable or spawning tools for input. X11 uses XShm, XDamage, XTest and EWMH. Wayland uses a combined RemoteDesktop and ScreenCast portal session where the person can be given control, and a ScreenCast-only session where not (see Live view by desktop), followed by PipeWire. Never bypass compositor consent through XWayland input. Portal capability discovery, rather than desktop-name guesses, controls advertised support, with one exception named below: KDE, whose RemoteDesktop portal is present but shares the whole desktop. Restore tokens are private files in the data directory; revoked consent still requires another prompt.

AT-SPI2 runs on its separate accessibility D-Bus. Object bus names and paths identify stable refs, held in a capped cache. Queries and actions stay scoped to the approved application. Traversal has node, depth, reply-byte and time limits. Missing interfaces are ordinary capability differences; dead objects report `target_gone`.

## Protocol and wire additions

Add `screen-v2.ts` schemas and exports, preserving v1 definitions. New helpers accept `--endpoint unix:/path`. The owner creates a mode-0700 directory and mode-0600 socket. Requests and replies remain bounded newline JSON with request ids. `hello` returns version 2 capabilities, platform, capture/input support, semantic actions, codecs and permission states. Typed errors distinguish permission, missing targets, unsupported operations, bounds, busy, timeout and internal faults.

Frames retain the existing big-endian header-length and JPEG payload framing. V2 adds `seq`, `ts`, `scale` and optional dirty rectangles alongside the v1 session fields so the existing recording and fan-out code can keep working. `ui.tree`, `ui.find` and `ui.act` expose bounded accessibility operations. Agent tool descriptions direct agents to inspect the UI tree before using screenshots for visual checks.

Linux backend selection prefers Wayland when `WAYLAND_DISPLAY` is set, otherwise X11 when `DISPLAY` is set. An explicit selection can override this. A missing session fails with a clear headless error. The TypeScript owner validates negotiated capabilities before starting capture or issuing semantic operations.

## Security

Only the local daemon can reach the private frame endpoint. X11 itself has no isolation between clients, so the helper checks application identity, target lifetime, focus and coordinate bounds before input. Whole-display capture requires explicit approval; without a sharing dialog it is view-only, and a screen picked in the dialog takes only the person's input. Accessibility refs cannot authorize another application. The Wayland chooser is the final authority on capture scope. Input is advertised only when the portal grants it. Persisting a restore token does not grant new capabilities or remove the compositor's right to prompt again.

### X11 pointer input (revised 2026-10-22)

The first revision refused all X11 pointer input, because XTest events carry no recipient and land wherever a physical click at that point would. That left a person unable to use their own app from a live view. Pointer input is now split by who sends it. The daemon marks input from the person at a live view (`person: true`, set only when the session's controller is the human and the request comes from the client holding control); agents' pointer input stays refused, and agents act through accessibility.

A person's click, drag or wheel is delivered only under a server grab, so nothing changes between the checks and the events: the shared window is still the same application's window (identity and lifetime), it is the active window, the point is inside it, it is the topmost window at that point (no other app's window or overlay covers it), no other client holds the pointer, and no other client has a passive grab of that button on the root window. What remains is what the person's own mouse would do there. When the shared window is behind another app, a person's input first asks the window manager to activate it, as a click with their own mouse would, and is sent only once it is active.

### Wayland: the sharing dialog picks (revised 2026-10-22)

On Wayland the helper cannot list windows, so `targets` returns empty lists and says the machine's sharing dialog picks (`chooser`). Clients offer "Share a window or screen", which starts a `chooser` target: the helper opens one portal session offering windows and screens, and the person picks in the dialog on that machine. The start waits up to two minutes; clients say they are waiting for approval on that machine, with Cancel, which stops the starting session and closes the dialog. A decline or no answer ends the start with the helper's sentence. The restore token makes later starts silent. What was picked comes back with the start, named by the desktop id GNOME records for the window.

The portal's input lands wherever that point of the screen is, so it is sent to a shared window only while that window is the active one, as its accessibility says. Otherwise the app is asked to come forward (`org.freedesktop.Application.Activate`); GNOME keeps focus from apps without an activation token, so a window behind another app usually stays there, and the person's input is refused with a sentence: bring it to the front on that computer, or share the screen. On a desktop whose only keyboard is the portal's (headless GNOME), no window is active until that keyboard exists, so the helper wakes the portal's keyboard and pointer before the check.

A screen picked in the dialog is the person's to control: they granted remote control of that desktop there, and the compositor routes their clicks exactly where they see them. Agents never send it input. A whole display captured without a dialog (X11) stays view-only.

### Live view by desktop

Person control on Wayland needs a RemoteDesktop session whose input reaches exactly what the person shared. Where that doesn't hold, the helper asks ScreenCast alone, so the person is never asked to hand over input that would go unused, and reports the view as watch-only with the reason (`capabilities.watchOnly`). The daemon refuses a person's take-over of such a session with that reason, and the web and iPhone clients show it instead of a take-over control. Agents are unaffected: they act through accessibility element ids in computer use, never through a live view's input.

| Desktop                                                                                          | Watch                                                                            | Person control                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| X11 (any window manager, KDE on X11 included)                                                    | the window, by XShm                                                              | yes, under the grab and checks above                                                                                                               |
| GNOME on Wayland                                                                                 | the window or screen picked in the dialog                                        | yes, through RemoteDesktop, while the shared window is in front; a picked screen anywhere on it                                                    |
| KDE Plasma on Wayland                                                                            | the window or screen picked in ScreenCast's chooser                              | no: its RemoteDesktop portal ignores the source asked for and shares whole outputs, so a picked window's clicks could land anywhere on the desktop |
| Hyprland (xdg-desktop-portal-hyprland), Sway and other wlroots desktops (xdg-desktop-portal-wlr) | the window (Hyprland) or screen (wlr shares monitors only) picked in the chooser | no: these portals have no RemoteDesktop, and ace never sends input around the portal with compositor IPC or virtual input devices                  |

KDE is chosen by `XDG_CURRENT_DESKTOP`, the one desktop-name decision in the helper, because its portal advertises RemoteDesktop with a window source it doesn't honour. A screen-sourced RemoteDesktop session cropped to the picked window was considered for KDE and rejected: the portal never says where the window is, so bounding input to it would need compositor IPC (KWin scripting), which this ADR rules out. The ScreenCast-only session keeps its own restore token (`screencast-restore-token` beside `restore-token`), since ScreenCast and RemoteDesktop grants are stored apart. Desktops that send pictures only when the screen redraws (Hyprland) keep a screenshot's stream open between looks (COMPUTER.md); a live view's stream is open for its whole life anyway.

### One name per app

Live view and computer use name an application by its desktop id (`org.gnome.Calculator`), from the same identity code (`computer/identity.rs`, `computer/desktop.rs`), never by WM_CLASS.

The executable is installed once, never rewritten during a session. macOS releases require a stable bundle id, Developer ID signing, hardened runtime and notarization of an app bundle with Info.plist. Windows releases require Authenticode. Development builds use a stable signing identity; build scripts must not repeatedly ad-hoc sign production helpers.

## Performance

Damage notifications wake X11 capture. A pending change coalesces until the fps deadline; unchanged windows produce no frames. PipeWire frames use bounded buffers and content comparison because compositors may deliver repeated frames. JPEG encoding and frame writing have fixed size limits and bounded backpressure. Capture is released on explicit stop and after the last Linux viewer leaves, once queued input drains. Agent delegation and recording retain demand; bootstrap sessions await a viewer or explicit stop. This ends the capture session rather than silently reacquiring portal consent. Accessibility traversal caps work rather than collecting an entire app before pruning. Benchmarks report idle CPU, changing-window CPU, JPEG latency, tree latency and RSS without gating on elapsed time.

## Testing

For this revision, the repository owner requires all tests and benchmarks to run at merge time only. The following verification paths are provided but not executed for the delivered revision.

Run host unit tests for protocol validation, backend choice, portal policy, traversal caps and damage scheduling. Run real Xvfb, a window manager, a GTK app, accessibility bus and the helper in an ephemeral Debian Docker container. Assert capture bytes, damage changes, synthesized input, tree pruning, searches and semantic edits through the public command channel. Delete the test container and image on success or failure. Wayland requires manual GNOME and KDE sessions, including first consent, restore, revocation, window/display selection, scaling and reconnects. Fake helpers test TypeScript negotiation and tool routing without provider CLI access.
