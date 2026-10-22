# `--computer`: the Linux computer-use engine

`ace-screen-helper-linux --computer` serves the agent tools `screen_apps`, `screen_state` and
`screen_act` on Linux (ADR 0087, ADR 0093). It speaks the same wire as the macOS engine
(`ace-screen-helper --computer`), so the daemon's `ComputerClient` (`packages/screen/src/computer/`)
uses it unchanged. The code is in `src/computer/`; the live-view session mode (`--endpoint`) is
separate and unchanged.

## Wire

JSON lines on stdin and stdout. Requests are `{id, op, ...}` with any string id; replies are
`{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`. Messages are written for the
model and reach it unchanged. A request line may be up to 8 MB; a longer one is discarded and
answered `bad_request` by its id, and the next request still runs.

- `hello` → `{version: 2, accessibility, screenRecording, capabilities}`. `accessibility` is
  whether the AT-SPI bus is reachable; `screenRecording` whether windows can be captured (X11,
  or on Wayland an xdg-desktop-portal that offers ScreenCast).
  The helper sets `org.a11y.Status.IsEnabled` on the session bus, as screen readers do, so apps
  started afterwards expose their trees.
- `apps {query?}`, `resolve {app}`, `state {app, window?, screenshot, outline?, marks?}`,
  `act {app, actions, window?, screenshot, observe?}`: as on macOS (see `wire.ts`). Steps carry
  `when` guards; `if` is expanded by the daemon.
- `cancel {target}` is answered at once by the stdin thread with `{cancelled}`. The target stops
  at its next check (between steps, and every 50 ms inside waits and typing) and reports
  `cancelled` with the steps it finished.

Arguments: `--computer [--data-dir <absolute dir>]`. The daemon passes `<ACE_HOME>/screen`; the
helper keeps Wayland screen-sharing restore tokens under `<dir>/portal/`. Without it, tokens last
only for the process.

Ops run one at a time. Every AT-SPI call gives up after 1 s, walks stop at 4 s (2 s inside an
act) or 1,200 lines, and an app that stops answering yields a partial outline with
`notResponding: true` instead of a stuck helper. Stdin EOF or SIGTERM/SIGINT/SIGHUP end the
process.

## Apps

An app's identity (`bundleId` on the wire) is its desktop-file id, e.g. `org.gnome.TextEditor`,
taken in this order: `GIO_LAUNCHED_DESKTOP_FILE` (when `GIO_LAUNCHED_DESKTOP_FILE_PID` is the
process), a Flatpak's `/.flatpak-info`, the systemd unit in `/proc/<pid>/cgroup`
(`app-gnome-<id>-<n>.scope`, `app-<id>@….service`), X11 `_GTK_APPLICATION_ID`, the AT-SPI app
name, `WM_CLASS` against `StartupWMClass` and desktop ids, the executable against `Exec=`, and
finally the executable name. Names come from the desktop file. Running apps are those on the
AT-SPI registry with a window; installed ones are the `.desktop` files in `$XDG_DATA_HOME` and
`$XDG_DATA_DIRS` (NoDisplay/Hidden entries resolve but are not listed). `state` on an app that is
not running starts it with `gio launch` (falling back to its `Exec=` line) and waits up to 15 s
for its window.

The desktop's own components are never targets: shells and compositors (gnome-shell,
mutter-x11-frames, plasmashell, kwin*), portals (xdg-desktop-portal*), Xwayland, AT-SPI and
input-method daemons (at-spi*, ibus*), GNOME settings daemons (gsd-*), the calendar server and
alarm notifier, polkit agents, and on Hyprland/wlroots desktops bars, notifications, wallpaper,
idle and lock tools and launchers (waybar, mako, swaync, hyprpaper, hypridle, hyprlock, walker,
wofi, rofi, fuzzel, swaybg, …). `apps` leaves them out and `resolve`/`state`/`act` refuse them with
`app_not_allowed`. Matched on desktop id or executable name, case-insensitive.

## Outline

Nodes are the chosen window's AT-SPI tree in document order, plus open popup menus. Roles use the
standard AT-SPI names (not toolkit `GetRoleName` strings), renamed where the macOS engine uses
other words (`push button` → `button`, `frame` → `window`, `label` → `text`, an editable
multi-line `text` → `text area`). Unnamed containers fold away, captions that repeat their
control's name are dropped, hidden subtrees are skipped. Ids are stable per element across looks;
a recycled list row gets a new id. Password text is never read. Settling waits for the app's
AT-SPI events to go quiet rather than sleeping.

## Steps

Semantic steps go through AT-SPI and work on windows in the background, on X11 and Wayland.
Raw input goes through XTest and only reaches the active window, so on X11 it runs only when the
target window is active (`_NET_ACTIVE_WINDOW`); otherwise it fails with `not_on_screen` and tells
the agent to add `activate` or use an element id. Wayland has no way for ace to send input, so raw
steps fail with `not_supported`.

| Step                                                                     | X11                                    | Wayland                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `click {id}` (press, select, focus a field)                              | works in background                    | works in background                                                                            |
| `click {id}` with modifiers, hold, middle button                         | foreground only                        | unsupported                                                                                    |
| `click {x,y}`, `move`, `drag`                                            | foreground only                        | unsupported                                                                                    |
| `type`, `paste` into a text element                                      | works in background (EditableText)     | works in background                                                                            |
| `type`/`paste` with nothing editable focused                             | foreground only (XTest / clipboard)    | unsupported                                                                                    |
| `key`: Return, Backspace, Delete, arrows, Home/End, cmd/ctrl+A in text   | works in background                    | works in background                                                                            |
| `key`: other keys and shortcuts                                          | foreground only                        | unsupported                                                                                    |
| `set_value`, `select_text`, `focus`, `action`, `scroll_to`               | works in background                    | works in background                                                                            |
| `menu {path}` (apps with a menu bar, e.g. GTK3)                          | works in background                    | works in background                                                                            |
| `scroll {id}` (moves the scroll bar's value)                             | works in background                    | works in background                                                                            |
| `scroll {x,y}` or without a scroll bar                                   | foreground only (wheel)                | unsupported                                                                                    |
| `window` close, minimize, restore, zoom, fullscreen, raise, move, resize | works (EWMH)                           | close, minimize, zoom, fullscreen via the app's own GTK4 window actions; otherwise unsupported |
| `activate`                                                               | works (`_NET_ACTIVE_WINDOW`)           | asks via GrabFocus; compositors usually refuse                                                 |
| `wait`, `wait_for`, `when`                                               | works                                  | works                                                                                          |
| screenshot and id marks                                                  | works (Composite, covered windows too) | works through the ScreenCast portal once the person approves (see below)                       |

Keys: the tool schema is written for macOS. On Linux `cmd` is Control, so `cmd+s` is Ctrl+S, the
same intent as ⌘S; `ctrl` is Control too; `super`, `meta` and `win` name the Super key; `alt` and
`option` are Alt; `fn` is ignored.

## Wayland screenshots

Screenshots on Wayland go through the xdg-desktop-portal ScreenCast interface (GNOME, KDE,
xdg-desktop-portal-hyprland), never a compositor-private API (ADR 0049). Each screenshot opens a
ScreenCast-only portal session with `persist_mode=2` and the app's restore token, takes one
PipeWire frame (cropped to the window with the stream's VideoCrop metadata), and closes the
session, so nothing streams between screenshots and the desktop's sharing indicator only shows
for that moment. The source type is WINDOW when the portal offers it (tokens are kept per app id),
else MONITOR (one token; no marks, since window positions can't be related to the monitor).

The first time, the portal shows its dialog and the person picks the window. The request does not
wait for that: it returns the outline with `screenshotError` saying the person must approve
screen sharing for the app in the dialog that just opened, then look again. The dialog stays up
for up to five minutes; the next look after approval takes the picture and saves the token. Later
screenshots restore silently. A revoked or rejected token asks the person again with the same
message; a declined dialog is reported, and the next screenshot request opens the dialog again.
An agent can't approve the dialog itself: GNOME's window list exposes no accessible action.

## Hyprland and wlroots desktops

Omarchy (Arch with Hyprland) runs xdg-desktop-portal-hyprland (XDPH 1.4.x on Arch, 1.3.11 on
Ubuntu 26.04); Sway runs xdg-desktop-portal-wlr. Both offer ScreenCast and Screenshot: XDPH
advertises monitors and windows, xdg-desktop-portal-wlr monitors only, so on Sway a screenshot
shares the whole monitor and carries no id marks. Neither offers
RemoteDesktop: XDPH 1.4 adds InputCapture, which hands input _out of_ the desktop (Barrier-style)
and is no way to send it in. So on these desktops:

- Semantic steps (AT-SPI) work as on GNOME, in the background. Raw clicks, keys and wheel steps
  are unsupported, as on any Wayland desktop.
- Window operations stay what the app itself offers (GTK4 window actions). Hyprland's and
  Sway's control sockets (`hyprctl`, `swaymsg`) could move, focus or close any window without the
  person's consent; ADR 0049 limits shipped code to portals, so the helper doesn't use them. Only
  the e2e scripts use them, to read the monitor and window lists.
- The first screenshot asks through the compositor's chooser (`hyprland-share-picker`, or the
  chooser command configured for xdg-desktop-portal-wlr). XDPH asks during SelectSources rather
  than Start and serves one request at a time, so the helper waits on both the same way and
  never waits on Close (a backend still showing its chooser can't answer it). Restore tokens
  (`persist_mode=2`, ScreenCast v4+) restore silently afterwards.
- XDPH asks Hyprland for a window's picture with `ignore_damage` off (1.3.11 through current
  master), and Hyprland hands it over on that monitor's next redraw, which can be never on an
  idle desktop. When a new session's stream sends nothing within three seconds, the look says
  so and the session stays open (two minutes after the last look), always holding the picture
  from the latest redraw: the agent's next action redraws the app, so the next look has it.
  Desktops that send a picture at once (GNOME, KDE) still close the session after each look.
- XDPH 1.3 marks its shared-memory buffers mappable but not readable, so PipeWire's own mapping
  can't be read; the helper maps such a buffer read-only itself, after checking its size.

`paste` with nothing editable borrows the X clipboard: it reads the current text, serves the
pasted text, sends Ctrl+V, then serves the old text again. X keeps no clipboard of its own, so
after the helper exits that text survives only if a clipboard manager took it.

## Testing

`cargo test` covers the pure parts: wire framing and limits, cancellation, desktop-file parsing and
identity (with temp XDG and proc dirs), app resolution, outline rules, id stability, `when`
conditions, key chords, text and menu matching, screenshot fitting, marks and base64.

Live checks run on a real desktop (Xvfb, Openbox, the AT-SPI bus, GNOME Text Editor, GNOME
Calculator, Mousepad, xterm, xdotool):

- `tests/computer/run-live.sh [display]`: the helper over stdin on X11: wire limits, `apps` and
  `resolve`, outline and JPEG screenshot, typing and editing text by id, pressing Calculator
  buttons by id, menus by path, `when`, `wait_for`, `cancel`, a hung (SIGSTOPped) app, SIGTERM,
  and raw input refused for a background window.
- `tests/computer/run-client-e2e.sh [display]`: the daemon's real `ComputerClient` and
  `screen_*` tools against the helper (run `bun install` at the repo root first).
- `tests/computer/run-wayland.sh`: a headless GNOME Shell Wayland session
  (`wayland-session.sh`: its own D-Bus, runtime dir, PipeWire and WirePlumber). Covers:
  - outline, pressing and typing by id, launching an app;
  - the shell and portals refused as targets, and raw input and window moves refused;
  - screenshots: first use opens the dialog without blocking the request, declining it, a grant,
    silent restore after a helper restart, and a revoked grant asking again.

  The approval itself is test scaffolding, because a headless GNOME Shell gives a test no way to
  click the dialog's window list. `seed_portal.py` records the grant as the dialog would: a
  `screencast` permission-store entry in GNOME's restore format plus the token file.
  `portal_dialog.py` reads the dialog and presses Cancel through AT-SPI. Neither is used by the
  helper. Needs `gir1.2-atspi-2.0`.

## Known gaps

- GTK4 reports element positions only relative to its window, and those positions drift by a few
  pixels inside nested containers, so id marks on GTK4 screenshots can sit slightly off their
  controls. GTK3 and Qt report screen positions and are exact. Wayland window frames don't change
  this: the drift is in GTK4's own extents.
- The portal doesn't say which app a window stream shows. If the person picks another window in
  the dialog, that window is what the agent sees for that app until the grant is revoked.
- The restore path was verified in a headless GNOME Shell with a seeded grant, and end to end on
  headless KDE Plasma 6 (Wayland and X11) with KDE's chooser answered through its accessibility
  tree (`tests/computer/run-kde.sh`). Hyprland (XDPH 1.3.11 and 1.4.1) and Sway run in
  `apps/daemon/scripts/linux-e2e/run.sh hyprland|sway` with a scripted chooser
  (`portal-picker.sh`), on arm64 with a virtual display; a real x86 Omarchy machine is still to
  be checked by hand.
- Each Wayland screenshot opens and closes a portal session (about half a second), except on
  desktops that send pictures only on redraw (see Hyprland above).
- GTK4 apps have no menu bar; their menus are buttons in the window, so `menu` paths fail with
  `no_menu_bar` and the agent clicks the menu button and item by id.
- XTest pointer input is checked against the active window before each step, not before each
  event; a window that loses focus mid-step can receive the rest of that step's input.
- Rich (`html`, `markdown`) paste is inserted as plain text.
