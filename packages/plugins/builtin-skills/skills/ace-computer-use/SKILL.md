---
name: ace-computer-use
description: Operate a native macOS or Linux desktop app, iOS simulator or Android emulator through ace when the person names one or wants to watch it in ace. Use before screen_* or sim_* tools.
---

# Native apps and simulators in ace

ace works in Mac apps in the background through the accessibility API: apps open without coming forward, and your clicks and keys go to the app, not to the person's cursor or keyboard. They can keep working while you do. On Linux the same tools read apps through AT-SPI accessibility; see "On Linux" below. The person turns the `screen` (desktop apps) and `devices` (simulators) groups on in ace's Settings; `context` says which are on. If `screen_disabled` comes back, tell the person.

Websites belong in ace's browser (`browser_open`, guide ace-browser). Files and data belong to your shell. Never drive app UI with `osascript` or AppleScript.

## A desktop app (screen_*)

1. `screen_state {app}` opens the app if needed and returns its window as an outline. `app` is a name or bundle id; `screen_apps {query}` finds the exact one.
2. `screen_act {app, actions}` runs up to 20 steps in order, then returns what changed. Batch steps that need no look in between.
3. Read the result, then act again. Call `screen_state` only when you need a fresh look without acting.

The outline has one line per element, indented by nesting:

```
4 standard window Untitled
	12 text area (focused), Value: Dear Ada,
	15 pop up button (collapsed) Format, Value: Plain text
	16 button Save
```

Ids stay the same between looks, so later results are a diff: `+` lines are new, `~` lines changed, unmarked lines are context, `Removed: 3-5` lists ids that are gone. "No change since your last look." means the action had no visible effect. Pass `full: true` to get the whole outline again. A `Windows` line lists the app's windows; pass `window` (its number, or part of its title) to look at another.

### Choosing an action

- **Click by id**: `{"type":"click","id":15}`. It presses the element directly, even when the window is covered or on another Space. `count: 2` double-clicks; `button: "right"` opens the context menu, `"middle"` middle-clicks; `modifiers: ["cmd"]` ⌘-clicks (also `shift`, `alt`, `ctrl`, `fn`); `hold_ms` long-presses.
- **Click by x,y** only for things missing from the outline (canvases, images). The coordinates are pixels of the latest screenshot of that window, nothing else; take a new one after the window changes.
- **Hover**: `{"type":"move","id":15}` posts a move to that window. Effects that depend on the real pointer, such as some tooltips, may not appear.
- **Fields**: `set_value` replaces a field's whole value in one step and is the most reliable. `type` types at the caret, like a keyboard, for apps that react to keystrokes (search-as-you-type, chat boxes); give it an `id` to focus that field first. `select_text` selects a passage (`prefix` or `suffix` tell repeats apart), or with `cursor` places the caret before or after it, so the next `type` edits in place.
- **Long or formatted text**: `{"type":"paste","text":"…","format":"markdown"}` keeps headings, lists, bold and links (`html` works too). The person's clipboard is put back afterwards. In a background app rich paste may land as plain text; the result says so.
- **Keys**: `{"type":"key","key":"cmd+s"}`, `"Return"`, `"Escape"`, `"Down"` with `repeat`, `hold_ms` to hold, `id` to focus first. In a background app, ⌘ shortcuts run their menu item, and ⌘A/⌘C/⌘X/⌘V edit the focused text directly. After you copy, the result quotes what was copied.
- **Menus**: `{"type":"menu","path":["File","Export…"]}` runs a menu command without opening the menu. Prefer it to shortcuts when you know the path; the `Menu bar:` line of a full outline names the top-level menus.
- **Windows**: `{"type":"window","op":"resize","width":900,"height":600}`; also `close`, `minimize`, `restore`, `zoom`, `fullscreen`, `raise` and `move` (`x`, `y` in screen points). It acts on the window you looked at.
- **Other**: `scroll` (an id or a point, `direction`, and `pages` or `pixels`), `scroll_to {id}` to bring an element into view, `action` for an element's listed `Actions`, `focus`, `drag` (`from` and `to` as `[x, y]` or `{"id": n}`, with `modifiers`), `wait`.

### Fewer round trips

Batch consecutive actions into one `screen_act`, up to 20 steps. Read once after the batch, rather than after every click or field. Use `wait_for` at a dependency such as navigation or a dialog, and `if` for an optional branch:

- `{"type":"wait_for","text":"Saved"}` waits until that text appears (`gone: true`: until it goes, `id` for an element), up to `timeout_ms` (default 5000), instead of looking again.
- An `if` step runs the next steps only if the element is there now, so one batch can handle a dialog that may or may not show: `{"type":"if","text":"Replace"},{"type":"click","id":31}`. `steps: 2` guards two steps; `gone: true` inverts it. Skipped steps are listed as skipped, not failed.
- `observe: false` on `screen_act` skips the look afterwards when your next call looks anyway. `screen_state {app, outline: false, screenshot: true}` is the fastest look when only the picture matters.

Add `screenshot: true` to `screen_state` or `screen_act` when the outline does not show what you need: layout, images, colours, or a canvas you must click into. The image is the window alone, with each clickable element tagged by its outline id, so you can click by id what you found by sight. In a large window, `screen_state {app, find: "Invoice"}` lists only matching elements with their parents. "<App> is not responding" means the app is busy: the outline may be partial, so wait or look again.

If your call is stopped, the batch stops at its next step; work already done stays done, so look before you retry.

The person can watch: on a visible window a small marker shows where you act, and pressing Esc while you act stops you. `stopped_by_person` means stop and ask how to continue; `person_active` means the current control conflicts with their input. Prefer another element or window; brief conflicts are waited out inside the batch. Work in a different field using its element id to preserve their caret.

### When background input does not work

Use `set_value`, `paste`, element actions and menu paths when a posted key or click has no effect. Observe again before retrying; Electron's accessibility tree can take a moment to load. Windows on other Spaces receive events addressed to that window, without switching Spaces. Minimized windows need `window {op: restore}` for pointer input.

In a shared window or tab, target fields by id with `set_value`, `type` or `paste`. The helper preserves the person's caret and refuses commands that would use their first responder. Another tab's hidden page content may not be accessible until that tab is selected; changing the selected tab also changes what the person sees.

Keep the person's focus where it is. `activate` brings the app forward and interrupts their work; use it only when the person explicitly wants foreground control. If background alternatives fail, report the unsupported action.

While the Mac is locked, only controls still exposed through accessibility can work. If `screen_locked` reports missing controls, stop retrying those ids and use browser or non-GUI tools where available. Do not open replacement windows. Screenshots, posted input and `activate` are unavailable; the helper never unlocks the Mac. After unlock, observe again before acting. `session_unavailable` means the GUI session cannot be used; wait for it to return and observe again.

### On Linux

- `app` is the desktop-file id (`org.gnome.TextEditor`, a Flatpak app id) or the app's name; `screen_apps` shows both.
- Clicks by id, `set_value`, `type` into a field, `select_text`, `action` and menus work with the window in the background.
- Key presses, x,y clicks, drags and pixel scrolls need the window in front. A step that needs it fails and says so: put `{"type":"activate"}` first and retry, and tell the person you brought the app forward.
- Shortcuts use `ctrl` (`ctrl+s`), not `cmd`.
- "No graphical session" means nobody is logged in to a desktop ace can reach: ask the person to log in.

### Limits

- Password managers, system authentication prompts (polkit, pinentry), terminals, Script Editor, Automator, Shortcuts, ace itself and any app the person has listed are refused. Ask the person to do those steps, use your shell for commands, and never look for another way into a refused app.
- Ask the person before anything irreversible they did not ask for in so many words: sending a message or email, posting, buying, deleting, changing system settings. Read back what you will send.
- On Windows, or when this machine has no screen helper for the background tools, ace offers the older session tools instead (`screen_open_app`, `screen_ui_tree`, `screen_ui_act`, `screen_input`); their descriptions say how to use them.

## Simulators and emulators (sim_*)

sim_* drives the iOS simulators and Android emulators on this machine. Paired machines are different: reach them with `machines` and `delegate`.

1. `sim_list` shows simIds and status.
2. `sim_start` takes one for this thread, boots it if needed and starts capture. It is refused while a person or another agent holds it.
3. Read with `sim_ui` (pass `role`, `name` or `text` to find). Actionable elements carry refs like `@e3`. Act on a ref: `sim_act` with `action: "tap"` and `ref`, `"type"` with `ref` and `text`, or `"ui"` with a `uiAction`. Points (`x`, `y`), `swipe` and `key` are the fallbacks; `open_app`, `open_url`, `install` and `record_start` / `record_stop` cover apps and recordings; `clipboard_get` / `clipboard_set` read and set the clipboard.
4. `sim_screenshot` for a visual check, with or without the live view; `sim_logs` for a log tail.
5. `sim_stop` when you finish, so the person and other threads can use it.

`stale_ref` means the element has gone: read again; `lease_required` means call `sim_start` again, or wait while the person holds it. From a shell, `ace sim … --thread <your thread>` runs the same tools with the same refs (`ace sim --help`).
