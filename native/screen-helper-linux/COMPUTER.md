# `--computer`: the Linux computer-use engine

`ace-screen-helper-linux --computer` serves the agent tools `screen_apps`, `screen_state` and
`screen_act` on Linux (ADR 0087, ADR 0091). It speaks the same wire as the macOS engine
(`ace-screen-helper --computer`), so the daemon's `ComputerClient` (`packages/screen/src/computer/`)
uses it unchanged. The code is in `src/computer/`; the live-view session mode (`--endpoint`) is
separate and unchanged.

## Wire

JSON lines on stdin and stdout. Requests are `{id, op, ...}` with any string id; replies are
`{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`. Messages are written for the
model and reach it unchanged. A request line may be up to 8 MB; a longer one is discarded and
answered `bad_request` by its id, and the next request still runs.

- `hello` → `{version: 2, accessibility, screenRecording, capabilities}`. `accessibility` is
  whether the AT-SPI bus is reachable; `screenRecording` whether windows can be captured (X11).
  The helper sets `org.a11y.Status.IsEnabled` on the session bus, as screen readers do, so apps
  started afterwards expose their trees.
- `apps {query?}`, `resolve {app}`, `state {app, window?, screenshot, outline?, marks?}`,
  `act {app, actions, window?, screenshot, observe?}`: as on macOS (see `wire.ts`). Steps carry
  `when` guards; `if` is expanded by the daemon.
- `cancel {target}` is answered at once by the stdin thread with `{cancelled}`. The target stops
  at its next check (between steps, and every 50 ms inside waits and typing) and reports
  `cancelled` with the steps it finished.

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
| screenshot and id marks                                                  | works (Composite, covered windows too) | `screenshotError` explains the missing capture permission                                      |

Keys: the tool schema is written for macOS. On Linux `cmd` is Control, so `cmd+s` is Ctrl+S, the
same intent as ⌘S; `ctrl` is Control too; `super`, `meta` and `win` name the Super key; `alt` and
`option` are Alt; `fn` is ignored.

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
- `tests/computer/run-wayland.sh`: a headless GNOME Shell Wayland session: outline, pressing and
  typing by id, launching an app, and the refusals for screenshots, raw input and window moves.

## Known gaps

- GTK4 reports element positions only relative to its window, and those positions drift by a few
  pixels inside nested containers, so id marks on GTK4 screenshots can sit slightly off their
  controls. GTK3 and Qt report screen positions and are exact.
- Wayland screenshots (ScreenCast portal with a persisted restore token) are not implemented.
- GTK4 apps have no menu bar; their menus are buttons in the window, so `menu` paths fail with
  `no_menu_bar` and the agent clicks the menu button and item by id.
- XTest pointer input is checked against the active window before each step, not before each
  event; a window that loses focus mid-step can receive the rest of that step's input.
- Rich (`html`, `markdown`) paste is inserted as plain text.
