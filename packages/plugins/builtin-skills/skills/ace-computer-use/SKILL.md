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

- **Click by id**: `{"type":"click","id":15}`. It presses the element directly, even when the window is covered or on another Space. `count: 2` double-clicks; `button: "right"` opens the context menu, `"middle"` middle-clicks; `modifiers: ["cmd"]` ⌘-clicks (also `shift`, `alt`, `ctrl`, `fn`); `hold_ms` long-presses.
- **Click by x,y** only for things missing from the outline (canvases, images, web pages whose content the outline lacks). The coordinates are pixels of the latest screenshot of that window, nothing else; take a new one after the window changes. This works on windows on another Space or behind a full-screen app too, as do drags and wheel scrolling.
- **Hover**: `{"type":"move","id":15}` shows tooltips and hover menus. On a window on another Space or behind a full-screen app, hover effects usually do not show (they follow the person's real pointer); the result says so.
- **Fields**: `set_value` replaces a field's whole value in one step and is the most reliable. `type` types at the caret, like a keyboard, for apps that react to keystrokes (search-as-you-type, chat boxes); give it an `id` to focus that field first. `select_text` selects a passage (`prefix` or `suffix` tell repeats apart), or with `cursor` places the caret before or after it, so the next `type` edits in place.
- **Long or formatted text**: `{"type":"paste","text":"…","format":"markdown"}` keeps headings, lists, bold and links (`html` works too). The person's clipboard is put back afterwards. If an app ignores the rich paste it lands as plain text; the result says so.
- **Keys**: `{"type":"key","key":"cmd+s"}`, `"Return"`, `"Escape"`, `"Down"` with `repeat`, `hold_ms` to hold, `id` to focus first. In a background app, ⌘ shortcuts run their menu item, and ⌘A/⌘C/⌘X/⌘V edit the focused text directly. After you copy, the result quotes what was copied.
- **Menus**: `{"type":"menu","path":["File","Export…"]}` runs a menu command without opening the menu. Prefer it to shortcuts when you know the path; the `Menu bar:` line of a full outline names the top-level menus.
- **Windows**: `{"type":"window","op":"resize","width":900,"height":600}`; also `close`, `minimize`, `restore`, `zoom`, `fullscreen`, `raise` and `move` (`x`, `y` in screen points). It acts on the window you looked at.
- **Other**: `scroll` (an id or a point, `direction`, and `pages` or `pixels`), `scroll_to {id}` to bring an element into view, `action` for an element's listed `Actions`, `focus`, `drag` (`from` and `to` as `[x, y]` or `{"id": n}`, with `modifiers`), `wait`.

### Fewer round trips

Each look costs a turn. Batch every step whose outcome you can predict, and let the batch check for itself:

- `{"type":"wait_for","text":"Saved"}` waits until that text appears (`gone: true`: until it goes, `id` for an element), up to `timeout_ms` (default 5000), instead of looking again.
- An `if` step runs the next steps only if the element is there now, so one batch can handle a dialog that may or may not show: `{"type":"if","text":"Replace"},{"type":"click","id":31}`. `steps: 2` guards two steps; `gone: true` inverts it. Skipped steps are listed as skipped, not failed.
- `observe: false` on `screen_act` skips the look afterwards when your next call looks anyway. `screen_state {app, outline: false, screenshot: true}` is the fastest look when only the picture matters.

Add `screenshot: true` to `screen_state` or `screen_act` when the outline does not show what you need: layout, images, colours, or a canvas you must click into. The image is the window alone, with each clickable element tagged by its outline id, so you can click by id what you found by sight. In a large window, `screen_state {app, find: "Invoice"}` lists only matching elements with their parents. "<App> is not responding" means the app is busy: the outline may be partial, so wait or look again.

If your call is stopped, the batch stops at its next step; work already done stays done, so look before you retry.

The person can watch: on a visible window a small marker shows where you act, and pressing Esc while you act stops you. `stopped_by_person` means stop and ask how to continue; `person_active` means they are using that app right now, so wait a few seconds or work elsewhere.

### When background input does not work

Windows on another Space or behind a full-screen app work like visible ones: menus, shortcuts, typing, rich paste, clicks, drags and scrolling, without switching the person's Space. A minimised window takes no mouse input; restore it with `window {op: "restore"}` first. Safari pages in a window the person has not looked at for a while may show no page content in the outline: use a screenshot and x,y clicks there.

Some apps still ignore background input. If an action reports success but nothing changed, look again with a screenshot, then add `{"type":"activate"}` as the first step and retry. `activate` brings the app to the front and interrupts the person: use it only after background actions failed, and say that you did.

### Limits

- Password managers, system authentication prompts, terminals, Script Editor, Automator, Shortcuts, ace itself and any app the person has listed are refused. Ask the person to do those steps, use your shell for commands, and never look for another way into a refused app.
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
