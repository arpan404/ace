---
name: ace-computer-use
description: Operate a native macOS app, iOS simulator or Android emulator through ace when the person names one or wants to watch it in ace. Use before screen_* or sim_* tools.
---

# Native apps and simulators in ace

Use these tools when the person names a native app or a simulator, or wants to watch the work in ace. ace acts in the background through the accessibility API, and the person can take over at any moment. The person turns the `screen` (native apps) and `devices` (simulators) groups on in ace's Settings; `ace_status` says which are on. If `screen_disabled` comes back, tell the person.

Websites belong in ace's browser (`browser_open`, guide ace-browser), not in a browser window driven through screen_*.

## A native app (screen_*)

1. `screen_open_app` with the exact bundle id. It returns a `sessionId` and candidate windows. If several windows match, call `screen_windows` and pass a `windowId`. Calling it again with `windowId` switches window, with `url` opens a deep link, with `mode: "foreground"` uses the real cursor and keyboard (only when the app ignores background input; it moves the person's focus).
2. Read before acting: `screen_ui_tree`. Pass `role`, `name` or `text` to find elements instead of reading the whole tree. Elements carry stable refs.
3. Act semantically: `screen_ui_act` on a ref, or with `menu` such as `["File", "New Window"]`.
4. Fall back to `screen_input` (`click`, `type`, `paste`, `key`, `scroll`). Points are target-window points: divide screenshot pixels by the reported scale.
5. `screen_screenshot` is a visual check; the tree costs fewer tokens. `screen_measure` reports latency and frame hitches for one action.

Pass `sessionId` only when you control several apps.

## Simulators and emulators (sim_*)

sim_* drives the iOS simulators and Android emulators on this machine. Paired machines are different: reach them with `ace_machines` and `delegate_task`.

1. `sim_list` shows simIds and status.
2. `sim_start` takes one for this thread, boots it if needed and starts capture. It is refused while a person or another agent holds it.
3. Read with `sim_ui` (pass `role`, `name` or `text` to find), then `sim_act` with `action: "ui"` on a ref. `tap`, `long_press`, `swipe`, `type` and `key` are the coordinate and key fallbacks; `open_app`, `open_url`, `install` and `record_start` / `record_stop` cover apps and recordings.
4. `sim_screenshot` for a visual check, `sim_logs` for a log tail.
5. `sim_stop` when you finish, so the person and other threads can use it.

## Errors

Errors name the next call. `stale_ref` means read the tree again. `foreground_required` means reopen with `mode: "foreground"`. `lease_required` means call `sim_start` again, or wait while the person holds it.
