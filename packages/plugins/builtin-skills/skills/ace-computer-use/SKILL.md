---
name: ace-computer-use
description: Operate a native macOS app, iOS simulator or Android emulator through ace when the person names one. Use before screen_* or device_* tools.
---

# Native apps and devices in ace

ace's computer use acts in one app the person named, in the background, through the accessibility API. It sits beside any computer-use tool you have natively; pick it when the person wants the work visible in ace or asked for ace. The person turns the `screen` and `devices` groups on in ace's Settings; your session facts say which are on.

## A native app (screen_*)

1. `screen_open_app` with the app's exact bundle id. It returns candidate windows and a `sessionId`. When several windows match, pass a listed `windowId`, or use `screen_list_windows` and `screen_select_window`.
2. Read before acting: `screen_ui_tree`, or `screen_ui_find` for a role, name or text. Elements carry stable refs.
3. Act semantically first: `screen_ui_act` on a ref, `screen_menu` for a menu path such as `["File", "New Window"]`, `screen_open_url` for a deep link.
4. Then input: `screen_type`, `screen_paste`, `screen_key` (named key plus modifiers), `screen_scroll`, and `screen_click` at coordinates as the last resort.
5. `screen_screenshot` is a visual check; the tree costs fewer tokens.

Websites belong in `ace_browser_*` (skill ace-browser), which reads the page directly, rather than in screen_* on a browser window.

`screen_request_foreground` uses the real cursor and keyboard. Use it only when the app ignores background input, because it moves the person's focus. `screen_measure_interaction` measures latency and frame hitches for one action.

Errors name the next move. `foreground_required` means call `screen_request_foreground`. `window_ambiguous` means pick a `windowId`. `screen_disabled` means the person must turn computer use on: tell them.

## Simulators and emulators (device_*)

1. `device_list` shows the devices and their status.
2. `device_boot` boots one, and `device_start` takes it for this thread and starts capture. Both are refused while a person or another agent controls it.
3. Read before acting: `device_ui_tree` or `device_find`, then `device_act` on a ref. `device_tap`, `device_swipe`, `device_type` and `device_key` are the coordinate and key fallbacks.
4. `device_open_app`, `device_open_url`, `device_install`, `device_logs` and `device_record_start` / `device_record_stop` cover apps, logs and recordings.
5. `device_stop` releases capture when you finish, so the person and other threads can use the device.
