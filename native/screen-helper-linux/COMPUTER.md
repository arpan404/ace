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
  whether the AT-SPI bus is reachable; `screenRecording` whether windows can be captured (an
  xdg-desktop-portal that offers ScreenCast).
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
(`app-gnome-<id>-<n>.scope`, `app-<id>@….service`), the AT-SPI app name against desktop ids, the
executable against `Exec=`, and finally the executable name. Names come from the desktop file. Running apps are those on the
AT-SPI registry with a window; installed ones are the `.desktop` files in `$XDG_DATA_HOME` and
`$XDG_DATA_DIRS` (NoDisplay/Hidden entries resolve but are not listed). `state` on an app that is
not running starts it with `gio launch` (falling back to its `Exec=` line) and waits up to 15 s
for its window.

- **Chromium-based apps** (Chrome, Chromium, Brave, Edge, Vivaldi, and Electron apps such as VS
  Code, Slack, Discord, Obsidian; `chromium.rs`) expose their tree only when started with
  `--force-renderer-accessibility`: neither `org.a11y.Status` nor GNOME's screen-reader settings
  turn it on. ace starts them from their `Exec=` line with that switch (recognized by name, or by
  the Chromium files beside the binary), and waits for their pages to join the tree. One running
  without it gets an `accessibilityNote` asking the person to quit it so ace can reopen it.
  Chromium offers no `EditableText` on Linux, so typing into its fields is refused with that
  reason; web pages are for ace's browser tools.
- **Apps that read accessibility only at start** (Firefox) and were started before it was on are
  not on the bus: instead of opening them again, `state` answers `app_inaccessible`, asking the
  person to quit and reopen them. The daemon turns accessibility on for the session as soon as
  computer use is on, so apps opened afterwards are seen.
- **Suites in one process.** LibreOffice runs every module in `soffice.bin`: each module with a
  window is its own app (`libreoffice-writer`, `libreoffice-calc`), named by the window title's
  ending, and asking for one picks its window. Typing into a document reaches the paragraph that
  holds the caret.

The desktop's own components are never targets: shells and compositors (gnome-shell,
mutter-x11-frames, plasmashell, kwin*), portals (xdg-desktop-portal*), Xwayland, AT-SPI and
input-method daemons (at-spi*, ibus*), GNOME settings daemons (gsd-*), the calendar server and
alarm notifier, polkit agents, and on Hyprland bars, notifications, wallpaper,
idle and lock tools and launchers (waybar, mako, swaync, hyprpaper, hypridle, hyprlock, walker,
wofi, rofi, fuzzel, swaybg, and Omarchy 4's Quickshell shell, …). `apps` leaves them out and `resolve`/`state`/`act` refuse them with
`app_not_allowed`. Matched on desktop id or executable name, case-insensitive.

## Outline

Nodes are the chosen window's AT-SPI tree in document order, plus open popup menus. Siblings
are read together (each one's role, states, interfaces, children and the facts its line needs),
so a walk costs about one round of calls per level. A look within 2 s of the last, when the app
reported no change and the helper did nothing since, reuses the last walk (`walk::still_current`,
as on macOS). Measured in the VM: a repeat look 5–10 ms; a fresh look of Calculator about 50 ms,
LibreOffice Writer about 45 ms, VS Code about 110–210 ms; typing 200 characters about 35 ms.
Elements are disabled only when neither SENSITIVE (GTK 4) nor ENABLED (LibreOffice) is set. Roles use the
standard AT-SPI names (not toolkit `GetRoleName` strings), renamed where the macOS engine uses
other words (`push button` → `button`, `frame` → `window`, `label` → `text`, an editable
multi-line `text` → `text area`). Unnamed containers fold away, captions that repeat their
control's name are dropped, hidden subtrees are skipped. Ids are stable per element across looks;
a recycled list row gets a new id. Password text is never read. Settling waits for the app's
AT-SPI events to go quiet rather than sleeping.

## Steps

Semantic steps go through AT-SPI and work on windows in the background. Wayland gives other
programs no way to send input to an app's window, so raw steps fail with `not_supported` and
point the agent to element ids. The helper runs in Wayland sessions only; the daemon refuses an
X11 session before it starts the helper.

| Step                                                                   | Works                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `click {id}` (press, select, focus a field)                            | in the background                                                                                     |
| `click {x,y}`                                                          | on the clickable element under that screenshot pixel, or within 8 px of it; never the window          |
| `click` with modifiers, hold, middle button; `move`, `drag`            | unsupported                                                                                           |
| `type`, `paste` into a text element                                    | in the background (EditableText); into a document, its paragraph with the caret                       |
| `type`/`paste` with nothing editable focused, or into a Chromium field | unsupported, with the reason                                                                          |
| `key`: Return, Backspace, Delete, arrows, Home/End, ctrl+A in text     | in the background                                                                                     |
| `key`: ctrl+C / ctrl+X / ctrl+V in text                                | the text's own CopyText / CutText / PasteText                                                         |
| `key`: Tab                                                             | a tab in multi-line text; otherwise the focus moves to the next control (where the toolkit allows it) |
| `key`: a shortcut an app's menu lists (ctrl+s, F5, …)                  | presses that menu item, in the background (GTK 3, Qt, LibreOffice accelerators)                       |
| `key`: other keys                                                      | unsupported                                                                                           |
| `set_value`, `select_text`, `focus`, `action`, `scroll_to`             | in the background                                                                                     |
| `menu {path}` (apps with a menu bar, e.g. GTK3)                        | in the background; items the app turns off without focus say so                                       |
| `scroll {id}` or `scroll {x,y}`                                        | moves the scroll bar of the scroll area around the element or point                                   |
| `scroll` with no scroll bar                                            | unsupported                                                                                           |
| `window` close, minimize, zoom, fullscreen                             | through the app's own window actions (GTK4); otherwise unsupported                                    |
| `window` restore, raise, move, resize                                  | unsupported                                                                                           |
| `activate`                                                             | asks via GrabFocus; compositors usually refuse                                                        |
| `wait`, `wait_for`, `when`                                             | yes                                                                                                   |
| screenshot and id marks                                                | through the ScreenCast portal once the person approves (see below)                                    |

An x,y click needs a screenshot with marks of that window first: its pixels are mapped back to the
element frames read for the marks (`shot_offset`, `scale`).

Keys: the tool schema is written for macOS. On Linux `cmd` is Control, so `cmd+s` is Ctrl+S, the
same intent as ⌘S; `ctrl` is Control too; `super`, `meta` and `win` name the Super key; `alt` and
`option` are Alt; `fn` is ignored.

## Screenshots

Screenshots go through the xdg-desktop-portal ScreenCast interface (GNOME, KDE,
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

## Hyprland

Omarchy (Arch with Hyprland) runs xdg-desktop-portal-hyprland (XDPH 1.4.x on Arch, 1.3.11 on
Ubuntu 26.04). It offers ScreenCast and Screenshot, with monitors and windows, but no
RemoteDesktop: XDPH 1.4 adds InputCapture, which hands input _out of_ the desktop
(Barrier-style) and is no way to send it in. So on Hyprland:

- Semantic steps (AT-SPI) work as on GNOME, in the background. Raw clicks, keys and wheel steps
  are unsupported, as on any Wayland desktop.
- Window operations stay what the app itself offers (GTK4 window actions). Hyprland's control
  socket (`hyprctl`) could move, focus or close any window without the person's consent;
  ADR 0049 limits shipped code to portals, so the helper doesn't use it. Only the e2e scripts
  use it, to read the monitor and window lists.
- The first screenshot asks through the compositor's chooser (`hyprland-share-picker`). XDPH asks during SelectSources rather
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

## The person

The person always wins over the agent, as on macOS (`guard.rs`, the facts in `presence.rs`):

- **Stop.** While an agent acts in an app, a desktop notification says "ace is using <app>"
  with a **Stop** button (`notice.rs`); clicking the notice itself does the same, since Omarchy
  4's notifications and mako run only a notification's default action on a click and show no
  other buttons. Pressing it ends the running batch at its next step or
  wait, or the next batch when pressed between calls, with `stopped_by_person`: the agent is
  told to stop and ask the person how to continue. The press is then used up and the
  notification withdrawn; it comes back with the next batch, and leaves when the keep-awake
  lease ends. Only signals from the notification server that showed it count. GNOME Shell
  keeps the notice in its list after the banner hides (`resident`), so Stop stays in reach;
  elsewhere a hidden notice would move into the person's history with a Stop that no longer
  works, so it is `transient` there and the next batch shows it again. This stands in
  for two macOS affordances Wayland doesn't allow: Esc (GNOME's keyboard monitor,
  `org.freedesktop.a11y.KeyboardMonitor`, serves only the bus name
  `org.gnome.Orca.KeyboardMonitor`, and AT-SPI keystroke listeners go through it) and the marker
  drawn where the agent acts (no program may place a window over another app's, and Wayland
  gives no window positions to place one by).
- **The person using the app.** Before each step: when one of the app's windows is active and
  the person gave input within 1.5 s, a step in their window that names no element (keys, typing,
  menus) or acts on their focused control is refused with `person_active`; another element or
  window is independent. Input times come from GNOME's `org.gnome.Mutter.IdleMonitor`, else the
  compositor's `ext-idle-notify-v1` (KWin, Hyprland), else
  `org.freedesktop.ScreenSaver.GetSessionIdleTime`; where none answers, nothing is refused.
- **Locked or away.** Every look carries `sessionState` (`active`, `locked`, `unavailable`) and
  `screenLocked`. Locked comes from logind's `LockedHint` for the user's graphical session, the
  desktop's screensaver (`org.gnome.ScreenSaver` / `org.freedesktop.ScreenSaver` `GetActive`),
  a running session-lock client (hyprlock, swaylock), or Hyprland itself: its monitors list an
  active session lock (`LOCK` in `solitaryBlockedBy`) whichever client draws it, which is how
  Omarchy 4's lock screen, part of its Quickshell shell, is seen. While locked, accessibility steps still
  work and no screenshot is taken. When logind says the session isn't the active one (another
  user's is in front), actions fail with `session_unavailable`.
- **Kept awake** (`awake.rs`). During a look or batch the session doesn't go idle
  (`org.freedesktop.ScreenSaver.Inhibit`: GNOME through gsd-screensaver-proxy, KDE, hypridle).
  Between calls, for a five-minute lease the next call renews, only automatic suspend is held off
  (`org.gnome.SessionManager` with the suspend flag, else `org.freedesktop.PowerManagement`), so
  the screen may blank and lock. A failed, cancelled or stopped batch ends the lease. Nothing
  stops the person from locking, suspending or logging out, and inhibitors end with the helper.
  `--lease-seconds` shortens the lease for tests.

## Testing

`cargo test` covers the pure parts: wire framing and limits, cancellation, desktop-file parsing and
identity (with temp XDG and proc dirs), app resolution, outline rules, id stability, `when`
conditions, key chords, text and menu matching, screenshot fitting, marks and base64.

Live checks run in a throwaway headless GNOME Shell Wayland session (`wayland-session.sh`: its own
D-Bus, runtime dir, PipeWire and WirePlumber) with GNOME Text Editor, GNOME Calculator and
Mousepad, which a person closes the shell's overview over first:

- `tests/computer/run-live.sh`: the helper over stdin: wire limits, `apps` and `resolve`, typing
  and editing text by id, pressing Calculator buttons by id, menus by path (and one the app turns
  off in the background), `when`, `wait_for`, `cancel`, a hung (SIGSTOPped) app, SIGTERM, and
  shortcuts with no accessibility equivalent refused.
- `tests/computer/run-client-e2e.sh`: the daemon's real `ComputerClient` and `screen_*` tools
  against the helper (run `bun install` at the repo root first).
- `tests/computer/run-wayland.sh`:
  - outline, pressing and typing by id, launching an app;
  - the shell and portals refused as targets, and raw input and window moves refused;
  - screenshots: first use opens the dialog without blocking the request, declining it, a grant,
    silent restore after a helper restart, and a revoked grant asking again.
- `tests/computer/run-kde.sh`: the same on KDE Plasma 6 (KCalc, KWrite, Kate), with KDE's
  chooser answered through its accessibility tree.
- `tests/computer/run-hyprland.sh`: on Hyprland, the notice in mako, Stop by its button and by a
  click on the notice, and a lock screen seen through Hyprland from a lock program it doesn't
  know by name (a renamed swaylock, as Omarchy 4's shell runs no lock program).
- `tests/computer/run-person.sh`: the notice in GNOME Shell and a click on its Stop (with
  Mutter's remote-desktop pointer at the place the shell's accessibility tree gives), the
  session state and a lock (a stand-in hyprlock), and the inhibitors (stand-ins for GNOME's
  inhibit services, which a headless shell lacks). The person-active refusal is covered by unit
  tests only: no window of a headless shell is active.

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
  headless KDE Plasma 6 with KDE's chooser answered through its accessibility tree
  (`tests/computer/run-kde.sh`). Hyprland (XDPH 1.3.11 and 1.4.1) runs in
  `apps/daemon/scripts/linux-e2e/run.sh hyprland` with a scripted chooser
  (`portal-picker.sh`), on arm64 with a virtual display; a real x86 Omarchy machine is still to
  be checked by hand.
- Each screenshot opens and closes a portal session (about half a second), except on
  desktops that send pictures only on redraw (see Hyprland above).
- GTK4 apps have no menu bar; their menus are buttons in the window, so `menu` paths fail with
  `no_menu_bar` and the agent clicks the menu button and item by id.
- GTK 3 turns off menu items that need keyboard focus (Edit › Select All) while its window is in
  the background, and commands that act on the selection (Edit › Convert) didn't see a selection
  set through AT-SPI in the live checks.
- Rich (`html`, `markdown`) paste is inserted as plain text.
- Chromium and Electron fields take no typed text (no `EditableText` on Linux), and VS Code's
  menus have no items until opened, so its shortcuts can't be found through them.
- GTK 4 refuses to move the focus in a background window, so Tab between controls works only
  where the toolkit allows it.
- LibreOffice Calc's cells take no typed text; its "Input line" field does, with Return to enter.
