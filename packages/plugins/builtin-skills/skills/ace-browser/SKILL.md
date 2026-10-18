---
name: ace-browser
description: Open, test or debug a web page in ace's browser, which the person watches and uses alongside you. Use before ace_browser_* tools, for localhost dev servers, UI checks and console or network evidence.
---

# ace's browser

Each thread has a browser with tabs inside ace, shared by you and the person. They see one tab at a time and can click, type or navigate in any tab at any moment, including yours. It sits beside any browser or computer-use tool you have natively. Pick it when the person should watch the page, or when you need its console, network, timing or recording tools.

## Drive a page

1. `ace_browser_open` with `url` (HTTP or HTTPS, localhost included). It returns the `tabId` you work in. Without a url it reports your current tab.
2. `ace_browser_snapshot` reads the accessibility tree. Each node has a **ref**.
3. Act on refs: `ace_browser_click` (or `x`, `y` for a point), `ace_browser_type` (replaces the field's text), `ace_browser_fill_form` (several fields at once), `ace_browser_press` (keys such as `Enter`, `Control+a`), `ace_browser_select`, `ace_browser_check`, `ace_browser_hover`, `ace_browser_drag`, `ace_browser_upload`.
4. After a click or key that navigates, call `ace_browser_wait_for` with exactly one of `url`, `text` or `ref` plus `state`. Then snapshot again.

**Refs** belong to the latest snapshot of the current document. Navigation expires them. A `stale_ref` error means: snapshot again and use a current ref. `ace_browser_find` (role and name) and `ace_browser_find_text` locate elements without reading the whole tree.

## Tabs

Every page tool takes an optional `tabId`. Without one, a tool acts in your current tab: the last tab you opened or selected.

- `ace_browser_open` with `newTab: true` and a `label` opens a tab of your own and returns its `tabId`.
- `ace_browser_tabs`: `list` (each tab's `tabId`, url, title, label, who opened and drives it, `inUse` for the agent working there, `private`, `pending_dialog`; `current` marks yours), `open`, `select`, `close`.
- `ace_browser_close` with `tabId` closes that tab. Close the tabs you opened when you are done.
- Commands in different tabs run at the same time; a dialog holds only its own tab.

**Parallel agents and subagents** share one browser. Each must open its own labelled tab (`ace_browser_open` with `newTab` and `label`) and pass that `tabId` to every browser tool, so no two agents drive the same page. Subagents of one provider can share an identity, so do not rely on the current tab there.

## Evidence

- `ace_browser_logs`: console and network entries, filtered by kind, level, URL or status. `ace_browser_network_body` reads one response body by its `requestId` from the logs.
- `ace_browser_screenshot`: a visual check of one tab (`fullPage` for the whole page, `ref` for one element). It never changes the tab the person sees. Snapshots cost fewer tokens; use them for structure.
- `ace_browser_pdf`: print a tab to a PDF file. `ace_browser_downloads`: what the tabs downloaded, or `wait` for downloads to finish. `ace_browser_extensions`: the installed extensions (read-only).
- `ace_browser_evaluate`: runs JavaScript in the page.
- `ace_browser_measure_interaction`: input latency and frame hitches for one action.
- `ace_browser_record_start` and `ace_browser_record_stop`: a recording attached to the thread.

## Page settings

`ace_browser_resize`, `ace_browser_emulate` (device, touch, colour scheme), `ace_browser_history` (back, forward, reload) and `ace_browser_dialog` (answer an alert or prompt). `ace_browser_close` without `tabId` closes the whole browser.

## Working beside the person

The person never has to take over or hand back. While you work in a tab it is marked as yours, and they can still use it.

- When they are typing, clicking or scrolling in your tab, your clicks, typing, keys, scrolls and navigation there wait until they pause. If they keep going, the tool fails with `human_active`: snapshot again (the page may have changed), then retry or use another tab. Reads (snapshot, screenshot, evaluate, logs) never wait.
- A tab the person marks "Keep agents out" is theirs alone: tools there fail with `human_private`. Use another tab.

## When only the person can do it

Some steps belong to the person: signing in, a CAPTCHA, a two-factor code, a dialog you should not answer for them. Never type a password, code or other credential yourself, even one you can see in the thread or a file, and never try to get past a CAPTCHA.

1. Snapshot first to be sure the page really waits on them.
2. Call `ace_browser_request_help` with the `tabId`, a `reason` (`login`, `captcha`, `two_factor`, `dialog` or `other`) and a one-sentence `message` saying what to do there ("Sign in with your work account"). ace notifies them and shows the tab.
3. `done`: snapshot that tab again and carry on. `skipped`: they won't, so work around it or say what you could not finish. `pending`: end your turn; their answer arrives as their next message.

Ask once per blocker. Don't ask for anything you could do yourself.

## Another machine

Every browser tool takes `machine` (a name from `ace_machines`) to act in that machine's ace browser, for example to test a dev server running there.

## The person's own Chrome

With "Use my Chrome" set up, every browser tool takes `browser: "user"` to act in the person's own Chrome, signed in as them, with their extensions. Use it only when the task needs their session (a dashboard behind their SSO, their staging login); otherwise stay in ace's browser.

- `ace_browser_open` with `browser: "user"` gives you your own tab in an "ace" window of their Chrome.
- Tabs the person shared appear in `ace_browser_tabs` `list` (with `browser: "user"`) with `openedBy` human. Pass one's `tabId` to work in it; `ace_browser_close` with that `tabId` lets go of it and leaves it open for them.
- Pass `browser: "user"` on every call for those tabs. A tab the person closes, un-shares or stops is gone; nothing moves it to ace's browser. If their browser is not connected, the tools say so: ask them, or use ace's browser.
- Their Chrome refuses settings, extension and password pages. ace has no cookie or storage tools there.
