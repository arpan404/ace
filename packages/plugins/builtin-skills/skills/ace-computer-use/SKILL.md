---
name: ace-computer-use
description: Operate a native macOS app, iOS simulator or Android emulator through ace when the person names one or wants to watch it in ace. Use before screen_* or sim_* tools.
---

# Native apps and simulators in ace

ace works in Mac apps in the background through the accessibility API: apps open without coming forward, and your clicks and keys go to the app, not to the person's cursor or keyboard. They can keep working while you do. The person turns the `screen` (Mac apps) and `devices` (simulators) groups on in ace's Settings; `context` says which are on. If `screen_disabled` comes back, tell the person.

Websites belong in ace's browser (`browser_open`, guide ace-browser). Files and data belong to your shell. Never drive app UI with `osascript` or AppleScript.

## A Mac app (screen_*)

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

- **Click by id**: `{"type":"click","id":15}`. It presses the element directly, even when the window is covered or on another Space. `count: 2` double-clicks; `button: "right"` opens the context menu.
- **Click by x,y** only for things missing from the outline (canvases, images). The coordinates are pixels of the screenshot ace returned, nothing else.
- **Fields**: `set_value` replaces a field's whole value in one step and is the most reliable. `type` types at the caret, like a keyboard, for apps that react to keystrokes (search-as-you-type, chat boxes). `select_text` selects a passage, or with `cursor` places the caret before or after it, so the next `type` edits in place.
- **Long or formatted text**: `{"type":"paste","text":"…","format":"markdown"}` keeps headings, lists, bold and links (`html` works too). The person's clipboard is put back afterwards. In a background app rich paste may land as plain text; the result says so.
- **Keys**: `{"type":"key","key":"cmd+s"}`, `"Return"`, `"Escape"`, `"Down"` with `repeat`. In a background app, ⌘ shortcuts run their menu item, and ⌘A/⌘C/⌘X/⌘V edit the focused text directly.
- **Menus**: `{"type":"menu","path":["File","Export…"]}` runs a menu command without opening the menu. Prefer it to shortcuts when you know the path; the `Menu bar:` line of a full outline names the top-level menus.
- **Other**: `scroll` (an id or a point, with `direction`), `action` for an element's listed `Actions`, `focus`, `drag`, `wait`.

Add `screenshot: true` to `screen_state` or `screen_act` when the outline does not show what you need: layout, images, colours, or a canvas you must click into. The image is the window alone, with each clickable element tagged by its outline id, so you can click by id what you found by sight. In a large window, `screen_state {app, find: "Invoice"}` lists only matching elements with their parents.

The person can watch: on a visible window a small marker shows where you act, and pressing Esc while you act stops you. `stopped_by_person` means stop and ask how to continue; `person_active` means they are using that app right now, so wait a few seconds or work elsewhere.

### When background input does not work

Some apps ignore background input. Electron and Chromium apps (Slack, Discord, VS Code) often do while their window is off-screen, minimised or on another Space. If an action reports success but nothing changed, look again with a screenshot, then add `{"type":"activate"}` as the first step and retry. `activate` brings the app to the front and interrupts the person: use it only after background actions failed, and say that you did.

### Limits

- Password managers, system authentication prompts and terminals are refused. Ask the person to do those steps, and use your shell for commands.
- Ask the person before anything irreversible they did not ask for in so many words: sending a message or email, posting, buying, deleting, changing system settings. Read back what you will send.
- On Windows and Linux ace offers the older session tools instead (`screen_open_app`, `screen_ui_tree`, `screen_ui_act`, `screen_input`); their descriptions say how to use them.

## Simulators and emulators (sim_*)

sim_* drives the iOS simulators and Android emulators on this machine. Paired machines are different: reach them with `machines` and `delegate`.

1. `sim_list` shows simIds and status.
2. `sim_start` takes one for this thread, boots it if needed and starts capture. It is refused while a person or another agent holds it.
3. Read with `sim_ui` (pass `role`, `name` or `text` to find), then `sim_act` with `action: "ui"` on a ref. `tap`, `long_press`, `swipe`, `type` and `key` are the coordinate and key fallbacks; `open_app`, `open_url`, `install` and `record_start` / `record_stop` cover apps and recordings.
4. `sim_screenshot` for a visual check, `sim_logs` for a log tail.
5. `sim_stop` when you finish, so the person and other threads can use it.

`stale_ref` means read again; `lease_required` means call `sim_start` again, or wait while the person holds it.
