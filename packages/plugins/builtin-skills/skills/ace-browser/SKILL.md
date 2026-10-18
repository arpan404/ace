---
name: ace-browser
description: Open, test or debug a web page in ace's browser, which the person watches live and can take over. Use before browser_* tools, for localhost dev servers, UI checks, and console or network evidence.
---

# ace's browser

Each thread has a real Chromium browser with tabs inside ace. The person sees one tab at a time, with a marker while an agent drives it, and can take any tab over at any moment.

**Use it when** you must verify UI, test a dev server (localhost works), let the person watch, or read console and network. **Use plain web fetch** when you only need a document's text and nobody needs to see it.

## Drive a page

1. `browser_open {url}` loads an http(s) URL in your tab and returns its `tabId`. Without `url` it reports where you are.
2. `browser_snapshot` returns the page as indented lines, one per meaningful element:
   ```
   - heading "Sign in" [level=1] [ref=e2-14]
   - textbox "Email" [ref=e2-31]: ada@example.com
   - button "Continue" [disabled] [ref=e2-40]
   ```
   At the default 120 lines it costs fewer tokens than a screenshot and, unlike one, gives exact text and refs. On a large page it stops at `maxNodes` and says so. To narrow it, pass `ref` (a container's ref, for just that part), `interactiveOnly:true`, or use `browser_find {role, name}`.
3. `browser_act {action, ref, ...}` performs `click` (a ref, or `x`, `y` for a point), `type` (replaces the field's text), `fill_form` (several `{ref, value}` fields at once), `press` (`Enter`, `Control+a`), `hover`, `select`, `check`, `uncheck`, `drag`, `focus`, `upload`, `scroll`, or `dialog` (answers a pending alert or prompt).
4. After an action that navigates, call `browser_wait_for` with one of `url`, `text`, or `ref` plus `state`. Then take a fresh snapshot.

Refs stay valid until the page navigates. A `stale_ref` error means: snapshot again and use a current ref.

## Tabs

Every page tool takes an optional `tabId`. Without one it acts in your current tab: the last tab you opened or selected.

- `browser_tabs {action:"list"}`: each tab's `tabId`, url, title, label, who opened it (`openedBy`) and who drives it (`drivenBy`), its `lease` while a person holds it, and `pending_dialog`. `current` marks yours.
- `browser_tabs {action:"open", url, label}` opens a tab of your own and returns its `tabId`. `select` makes `tabId` your current tab. `close` closes `tabId`; close the tabs you opened when you are done.
- Commands in different tabs run at the same time; a dialog or a person's takeover holds only its own tab. Your commands never move the tab the person is looking at.

**Parallel agents and subagents** share one browser. Each opens its own labelled tab and passes that `tabId` to every browser tool, so no two agents drive the same page. Subagents of one provider can share an identity, so do not rely on the current tab there.

## Evidence

- `browser_logs`: console and network entries, filtered by `kind`, `level`, `url` or `status`. Pass `requestId` to read one response body. `kind:"downloads"` lists what the tabs downloaded; `browser_wait_for {downloads:true}` waits for downloads to finish.
- `browser_screenshot`: one tab as an image (`fullPage` for the whole page, `ref` for one element), without changing the tab the person sees. `format:"pdf"` prints the tab to a PDF file instead.
- `browser_evaluate`: run JavaScript in the page. Use `mode:"read-only"` for reads.
- `browser_history`: lists recent entries; with `direction` it goes back, forward, reloads or stops.
- `browser_measure`: input latency and frame hitches for one interaction.
- `browser_settings`: `resize`, `emulate` (device, touch, colour scheme), `record_start`/`record_stop` (a recording of the tab the person views, attached to the thread), `extensions` (the installed extensions, read-only) and `close` (the whole browser and every tab).

## The person in control

When the person takes over a tab, tools in that tab fail with `human_controlled` or `human_private`; your other tabs keep working. Wait for their handback, then snapshot again. ace adds no approvals of its own: reads never prompt, and your provider's permission mode decides the rest.

## Another machine

Every browser tool takes `machine` (a name from `machines`) to act in that machine's ace browser, for example to test a dev server running there.

## The person's own Chrome

With "Use my Chrome" set up, every browser tool takes `browser: "user"` to act in the person's own Chrome, signed in as them, with their extensions. Use it only when the task needs their session (a dashboard behind their SSO, their staging login); otherwise stay in ace's browser.

- `browser_open` with `browser: "user"` gives you your own tab in an "ace" window of their Chrome.
- Tabs the person shared appear in `browser_tabs` `list` (with `browser: "user"`) with `openedBy` human. Pass one's `tabId` to work in it; `browser_tabs` `close` with that `tabId` lets go of it and leaves it open for them.
- Pass `browser: "user"` on every call for those tabs. A tab the person closes, un-shares or stops is gone; nothing moves it to ace's browser. If their browser is not connected, the tools say so: ask them, or use ace's browser.
- Their Chrome refuses settings, extension and password pages. ace has no cookie or storage tools there.
