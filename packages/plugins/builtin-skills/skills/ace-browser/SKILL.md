---
name: ace-browser
description: Open, test or debug a web page in ace's browser, which the person watches and can take over. Use before ace_browser_* tools, for localhost dev servers, UI checks and console or network evidence.
---

# ace's browser

Each thread has one Chromium page inside ace. The person sees it in the app and can take it over at any moment. It sits beside any browser or computer-use tool you have natively. Pick it when the person should watch the page, or when you need its console, network, timing or recording tools.

## Drive a page

1. `ace_browser_open` with `url` (HTTP or HTTPS, localhost included). Without a url it reports the current page.
2. `ace_browser_snapshot` reads the accessibility tree. Each node has a **ref**.
3. Act on refs: `ace_browser_click`, `ace_browser_type` (replaces the field's text), `ace_browser_press` (keys such as `Enter`, `Control+a`), `ace_browser_select`, `ace_browser_check`, `ace_browser_hover`, `ace_browser_drag`, `ace_browser_upload`.
4. After a click or key that navigates, call `ace_browser_wait_for` with exactly one of `url`, `text` or `ref` plus `state`. Then snapshot again.

**Refs** belong to the latest snapshot of the current document. Navigation expires them. A `stale_ref` error means: snapshot again and use a current ref. `ace_browser_find` (role and name) and `ace_browser_find_text` locate elements without reading the whole tree.

## Evidence

- `ace_browser_logs`: console and network entries, filtered by kind, level, URL or status. `ace_browser_network_body` reads one response body by its `requestId` from the logs.
- `ace_browser_screenshot`: a visual check. Snapshots cost fewer tokens; use them for structure.
- `ace_browser_evaluate`: runs JavaScript in the page.
- `ace_browser_measure_interaction`: input latency and frame hitches for one action.
- `ace_browser_record_start` and `ace_browser_record_stop`: a recording attached to the thread.

## Page settings

`ace_browser_resize`, `ace_browser_emulate` (device, touch, colour scheme), `ace_browser_history` (back, forward, reload) and `ace_browser_dialog` (answer an alert or prompt). `ace_browser_close` closes the page.

## The person in control

When the person takes over, tools pause with `human_controlled` or `human_private`. Wait for their handback, then snapshot again.

## Another machine

Every browser tool takes `machine` (a name from `ace_machines`) to act in that machine's ace browser, for example to test a dev server running there.
