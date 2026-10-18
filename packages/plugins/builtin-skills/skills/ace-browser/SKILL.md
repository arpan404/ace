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
4. After a click or key that navigates, call `ace_browser_wait_for` with exactly one of `url` (exact, or a glob such as `http://localhost:3000/orders/*`), `text`, `ref` plus `state`, `networkIdle: true` (after a save or other requests) or `timeMs`. Then snapshot again. `ace_browser_navigate` takes `waitUntil: "load"` or `"networkidle"` for pages that keep loading after their HTML.

A ref is clicked (or hovered, checked, dragged) once it holds still, only where it takes the click itself. `covered` means something sits on top (a banner, dialog or sticky header): dismiss it, snapshot again and retry. `not_hittable` means it is off screen or still moving: scroll it into view or wait, then retry. Nothing was clicked in either case.

**Refs** belong to the latest snapshot of the current document. Navigation expires them. A `stale_ref` error means: snapshot again and use a current ref. `ace_browser_find` (role and name) and `ace_browser_find_text` locate elements without reading the whole tree. On a large page the snapshot is cut short (`truncated` with a `hint`) or lists only landmarks and headings: pass one's `ref` to `ace_browser_snapshot` to read that part, and `depth` to read fewer levels.

## Tabs

Every page tool takes an optional `tabId`. Without one, a tool acts in your current tab: the last tab you opened or selected.

- `ace_browser_open` with `newTab: true` and a `label` opens a tab of your own and returns its `tabId`.
- `ace_browser_tabs`: `list` (each tab's `tabId`, url, title, label, who opened and drives it, `inUse` for the agent working there, `private`, `pending_dialog`; `current` marks yours), `open`, `select`, `close`, `keep`.
- Tabs you open are temporary: they close when your turn ends. Keep one the person should still find afterwards (a deliverable, a handoff) with `keep: true` on `ace_browser_open`, or `ace_browser_tabs` `keep` with its `tabId`. Tabs the person opened, is viewing or used lately stay anyway.
- `ace_browser_close` with `tabId` closes that tab now.
- Commands in different tabs run at the same time; a dialog holds only its own tab.
- Some pages need the person: a site's sign-in (`pending_auth`) holds its tab until they answer it in ace's Browser panel, and a certificate warning (`certificate_error`) refuses your input with `needs_person`. Never ask for or type a site password; tell the person. A sign-in popup (OAuth) opens as its own tab and your next result lists it in `popups_opened`.

**Parallel agents and subagents** share one browser. Each must open its own labelled tab (`ace_browser_open` with `newTab` and `label`) and pass that `tabId` to every browser tool, so no two agents drive the same page. Subagents of one provider can share an identity, so do not rely on the current tab there.

## Tabs the person points at

A message can carry a `<browser_tab tabId=… url=… title=…>` block: the person mentioned that tab. It holds a snapshot excerpt taken when the message arrived, and the tab's screenshot is attached. Pass its `tabId` to act there; its refs work until the page changes. `<browser_annotation_refs tabId=…>` names the elements the person annotated by ref, in the tab they annotated.

## Evidence

- `ace_browser_logs`: console and network entries, filtered by kind, level, URL or status. `ace_browser_network_body` reads one response body by its `requestId` from the logs.
- `ace_browser_screenshot`: a visual check of one tab (`fullPage` for the whole page, `ref` for one element). It never changes the tab the person sees. Snapshots cost fewer tokens; use them for structure. To click something you only see in the image, use the `scale` and `origin` beside it: click `x = origin.x + px * scale`, `y = origin.y + py * scale` for image pixel (px, py).
- `ace_browser_pdf`: print a tab to a PDF file. `ace_browser_downloads`: what the tabs downloaded, or `wait` for downloads to finish. `ace_browser_extensions`: the installed extensions (read-only).
- `ace_browser_evaluate`: runs JavaScript in the page. `mode: "read-only"` reads values and refuses side effects; the default may change the page.
- `ace_browser_measure_interaction`: input latency and frame hitches for one action.
- `ace_browser_record_start` and `ace_browser_record_stop`: a recording of your tab (or `tabId`), attached to the thread, even while the person views another tab. The person sees that you are recording and can stop it. While it records, password fields are masked and your cursor is hidden.

## Page settings

`ace_browser_resize`, `ace_browser_emulate` (device, touch, colour scheme), `ace_browser_history` (back, forward, reload) and `ace_browser_dialog` (answer an alert or prompt). `ace_browser_close` without `tabId` closes the whole browser.

## Working beside the person

The person never has to take over or hand back. While you work in a tab it is marked as yours, and they can still use it.

- When they are typing, clicking or scrolling in your tab, your clicks, typing, keys, scrolls and navigation there wait until they pause. If they keep going, the tool fails with `human_active`: snapshot again (the page may have changed), then retry or use another tab. Reads (snapshot, screenshot, evaluate, logs) never wait.
- When they work in the tab, `ace_browser_type` and `ace_browser_fill_form` add your text after the field's text instead of replacing it and leave their focus and caret alone; the result says `kept_text`. Snapshot to check the field.
- Leaving a page they edited asks them. Accepting its leave dialog, or navigating away on the desktop, fails with `unsaved_changes`: dismiss the dialog to stay, ask them, or use another tab.
- Passwords, one-time codes and card fields never reach you: snapshots show `••••••••` and screenshots show them blank.
- A tab the person marks "Keep agents out" is theirs alone: tools there fail with `human_private`. Use another tab.

## When a tool fails

Every failure has a `code` and a `hint` that says what to do next. The common ones:

- `page_unreachable`: `detail` names the network error. `net::ERR_CONNECTION_REFUSED` on localhost means the dev server is not running or listens on another port.
- `browser_restarted`: the browser or the daemon restarted and the tab reopened at its last address. Form input and refs are gone: snapshot again and redo the lost steps.
- A result with `pending_dialog` means a dialog holds the tab. Answer it with `ace_browser_dialog`, then retry.
- `evaluate_failed`: the script threw, ran over 10 seconds, or (in `read-only` mode) tried a side effect.

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
- Their Chrome refuses settings, extension and password pages. ace has no cookie or storage tools there, and `ace_browser_evaluate` there cannot read cookies or site storage unless the person allows it in Settings.
