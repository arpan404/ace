---
name: ace-browser
description: Open, test or debug a web page in ace's browser, which the person watches and uses alongside you. Use before browser_* tools, for localhost dev servers, UI checks and console or network evidence.
---

# ace's browser

Each thread has a real Chromium browser with tabs inside ace, shared by you and the person. They see one tab at a time and can click, type or navigate in any tab at any moment, including yours.

**Use it when** you must verify UI, test a dev server (localhost works), let the person watch, or read console and network. **Use plain web fetch** when you only need a document's text and nobody needs to see it.

## Drive a page

1. `browser_open {url}` loads an http(s) URL in your tab and returns its `tabId`. Without `url` it reports where you are. `waitUntil: "load"` or `"networkidle"` waits for pages that keep loading after their HTML; `networkidle` ignores sockets, event streams and requests open over 5 s, so a dev server's reload channel doesn't hold it.
2. `browser_snapshot` returns the page as indented lines, one per meaningful element:
   ```
   - heading "Sign in" [level=1] [ref=e2-14]
   - textbox "Email" [ref=e2-31]: ada@example.com
   - button "Continue" [disabled] [ref=e2-40]
   ```
   At the default 80 lines it costs fewer tokens than a screenshot and, unlike one, gives exact text and refs. On a large page it stops at `maxNodes` and says so; a very large page lists only its landmarks and headings. To narrow it, pass `ref` (a container's ref, for just that part), `depth`, `interactiveOnly:true`, or use `browser_find {role, name}`.
3. `browser_act {action, ref, ...}` performs `click` (a ref, or `x`, `y` for a point), `type` (replaces the field's text), `fill_form` (several `{ref, value}` fields at once), `press` (`Enter`, `Control+a`), `hover`, `select`, `check`, `uncheck`, `drag`, `focus`, `upload`, `scroll`, or `dialog` (answers a pending alert or prompt).
4. After an action that navigates, call `browser_wait_for` with exactly one of `url` (exact, or a glob such as `http://localhost:3000/orders/*`), `text`, `ref` plus `state`, `networkIdle: true` (after a save or other requests) or `timeMs`. Then take a fresh snapshot.

A ref is clicked (or hovered, checked, dragged) once it holds still, only where it takes the click itself. `covered` means something sits on top (a banner, dialog or sticky header): dismiss it, snapshot again and retry. `not_hittable` means it is off screen or still moving: scroll it into view or wait, then retry. Nothing was clicked in either case.

Refs stay valid until the page navigates. A `stale_ref` error means: snapshot again and use a current ref.

## Tabs

Every page tool takes an optional `tabId`. Without one it acts in your current tab: the last tab you opened or selected.

- `browser_tabs {action:"list"}`: each tab's `tabId`, url, title, label, who opened it (`openedBy`) and who drives it (`drivenBy`), `inUse` for the agent working there, `private`, `pending_dialog`. `current` marks yours.
- `browser_tabs {action:"open", url, label}` opens a tab of your own and returns its `tabId`. `select` makes `tabId` your current tab. `close` closes `tabId` now.
- Tabs you open are temporary: they close when your turn ends. Keep one the person should still find afterwards (a deliverable, a handoff) with `keep: true` on `open`, or `browser_tabs {action:"keep", tabId}`. Tabs the person opened, is viewing or used lately stay anyway.
- Commands in different tabs run at the same time; a dialog holds only its own tab. Your commands never move the tab the person is looking at.
- Some pages need the person: a site's sign-in (`pending_auth`) holds its tab until they answer it in ace's Browser panel, and a certificate warning (`certificate_error`) refuses your input with `needs_person`. Never ask for or type a site password; tell the person. A sign-in popup (OAuth) opens as its own tab and your next result lists it in `popups_opened`.

**Parallel agents and subagents** share one browser. Each opens its own labelled tab and passes that `tabId` to every browser tool, so no two agents drive the same page. Subagents of one provider can share an identity, so do not rely on the current tab there.

## Tabs the person points at

A message can carry a browser tab block with a `tabId`, url and title: the person mentioned that tab. It holds a snapshot excerpt taken when the message arrived, and the tab's screenshot is attached. Pass its `tabId` to act there; its refs work until the page changes. An annotation refs block with a `tabId` names the elements the person annotated by ref, in the tab they annotated.

## Evidence

- `browser_logs`: console and network entries, filtered by `kind`, `level`, `url` or `status`. Pass `requestId` to read one response body. `kind:"downloads"` lists what the tabs downloaded; `browser_wait_for {downloads:true}` waits for downloads to finish.
- `browser_screenshot`: one tab as an image (`fullPage` for the whole page, `ref` for one element), without changing the tab the person sees. To click something you only see in the image, use the `scale` and `origin` beside it: click `x = origin.x + px * scale`, `y = origin.y + py * scale` for image pixel (px, py). `sizes` checks a responsive layout: one image each at phone, tablet and desktop widths. `format:"pdf"` prints the tab to a PDF file instead.
- `browser_evaluate`: run JavaScript in the page. `mode:"read-only"` reads values and refuses side effects; the default may change the page.
- `browser_history`: lists recent entries; with `direction` it goes back, forward, reloads or stops.
- `browser_measure`: input latency and frame hitches for one interaction.
- `browser_settings`: `resize`, `emulate` (device, touch, colour scheme, user agent), `record_start`/`record_stop` (a recording of your tab, or `tabId`, attached to the thread even while the person views another tab; they see that you are recording and can stop it), `extensions` (the installed extensions, read-only) and `close` (the whole browser and every tab).

## Working beside the person

The person never has to take over or hand back. While you work in a tab it is marked as yours, and they can still use it. ace adds no approvals of its own: reads never prompt, and your provider's permission mode decides the rest.

- When they are typing, clicking or scrolling in your tab, your clicks, typing, keys, scrolls and navigation there wait until they pause. If they keep going, the tool fails with `human_active`: snapshot again (the page may have changed), then retry or use another tab. Reads (snapshot, screenshot, evaluate, logs) never wait.
- When they work in the tab, `type` and `fill_form` add your text after the field's text instead of replacing it and leave their focus and caret alone; the result says `kept_text`. Snapshot to check the field.
- Leaving a page they edited asks them. Accepting its leave dialog, or navigating away on the desktop, fails with `unsaved_changes`: dismiss the dialog to stay, ask them, or use another tab.
- Passwords, one-time codes and card fields never reach you: snapshots show `••••••••` and screenshots show them blank.
- A tab the person marks "Keep agents out" is theirs alone: tools there fail with `human_private`. Use another tab.

## When a tool fails

Every failure has a `code` and a `hint` that says what to do next. The common ones:

- `page_unreachable`: `detail` names the network error. `net::ERR_CONNECTION_REFUSED` on localhost means the dev server is not running or listens on another port.
- `browser_restarted`: the browser or the daemon restarted and the tab reopened at its last address. Form input and refs are gone: snapshot again and redo the lost steps.
- A result with `pending_dialog` means a dialog holds the tab. Answer it with `browser_act {action:"dialog"}`, then retry.
- `evaluate_failed`: the script threw, ran over 10 seconds, or (in `read-only` mode) tried a side effect.
- `not_hittable` or `covered` on a click: the press did not reach what you aimed at, so nothing was clicked. Snapshot again and retry.
- `viewport_mismatch` after `resize` or `emulate`: the tab kept another size (`detail` says which); screenshots and clicks use that size. Use `browser_screenshot` with `sizes` for a one-off look at other widths.

## When only the person can do it

Some steps belong to the person: signing in, a CAPTCHA, a two-factor code, a dialog you should not answer for them. Never type a password, code or other credential yourself, even one you can see in the thread or a file, and never try to get past a CAPTCHA.

1. Snapshot first to be sure the page really waits on them.
2. Call `browser_request_help` with the `tabId`, a `reason` (`login`, `captcha`, `two_factor`, `dialog` or `other`) and a one-sentence `message` saying what to do there ("Sign in with your work account"). ace notifies them and shows the tab.
3. `done`: snapshot that tab again and carry on. `skipped`: they won't, so work around it or say what you could not finish. `pending`: end your turn; their answer arrives as their next message.

Ask once per blocker. Don't ask for anything you could do yourself.

## Another machine

Every browser tool takes `machine` (a name from `machines`) to act in that machine's ace browser, for example to test a dev server running there.

## The person's own Chrome

With "Use my Chrome" set up, every browser tool takes `browser: "user"` to act in the person's own Chrome, signed in as them, with their extensions. Use it only when the task needs their session (a dashboard behind their SSO, their staging login); otherwise stay in ace's browser.

- `browser_open` with `browser: "user"` gives you your own tab in an "ace" window of their Chrome.
- Tabs the person shared appear in `browser_tabs` `list` (with `browser: "user"`) with `openedBy` human. Pass one's `tabId` to work in it; `browser_tabs` `close` with that `tabId` lets go of it and leaves it open for them.
- Pass `browser: "user"` on every call for those tabs. A tab the person closes, un-shares or stops is gone; nothing moves it to ace's browser. If their browser is not connected, the tools say so: ask them, or use ace's browser.
- Their Chrome refuses settings, extension and password pages. ace has no cookie or storage tools there, and `browser_evaluate` there cannot read cookies or site storage unless the person allows it in Settings.
