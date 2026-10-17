---
name: ace-browser
description: Open, test or debug a web page in ace's browser, which the person watches live and can take over. Use before browser_* tools, for localhost dev servers, UI checks, and console or network evidence.
---

# ace's browser

Each thread has a real Chromium page inside ace. The person sees it live, with a marker while an agent is in control, and can take it over at any moment.

**Use it when** you must verify UI, test a dev server (localhost works), let the person watch, or read console and network. **Use plain web fetch** when you only need a document's text and nobody needs to see it.

## Drive a page

1. `browser_open {url}` loads an http(s) URL. Without `url` it reports the current page. If the person has several tabs open, the result lists them; `browser_open {tabId}` switches to one.
2. `browser_snapshot` returns the page as indented lines, one per meaningful element:
   ```
   - heading "Sign in" [level=1] [ref=e2-14]
   - textbox "Email" [ref=e2-31]: ada@example.com
   - button "Continue" [disabled] [ref=e2-40]
   ```
   At the default 120 lines it costs fewer tokens than a screenshot and, unlike one, gives exact text and refs. On a large page it stops at `maxNodes` and says so. To narrow it, pass `ref` (a container's ref, for just that part), `interactiveOnly:true`, or use `browser_find {role, name}`.
3. `browser_act {action, ref, ...}` performs `click`, `type` (replaces the field's text), `press` (`Enter`, `Control+a`), `hover`, `select`, `check`, `uncheck`, `drag`, `focus`, `upload`, `scroll`, or `dialog` (answers a pending alert or prompt).
4. After an action that navigates, call `browser_wait_for` with one of `url`, `text`, or `ref` plus `state`. Then take a fresh snapshot.

Refs stay valid until the page navigates. A `stale_ref` error means: snapshot again and use a current ref.

## Evidence

- `browser_logs`: console and network entries, filtered by `kind`, `level`, `url` or `status`. Pass `requestId` to read one response body.
- `browser_screenshot`: the visible viewport as an image, for layout and visuals.
- `browser_evaluate`: run JavaScript in the page. Use `mode:"read-only"` for reads.
- `browser_history`: lists recent entries; with `direction` it goes back, forward, reloads or stops.
- `browser_measure`: input latency and frame hitches for one interaction.
- `browser_settings`: `resize`, `emulate` (device, touch, colour scheme), `record_start`/`record_stop` (a recording attached to the thread), and `close`.

## The person in control

When the person takes over, tools fail with `human_controlled` or `human_private`. Wait for their handback, then snapshot again. ace adds no approvals of its own: reads never prompt, and your provider's permission mode decides the rest.

## Another machine

Every browser tool takes `machine` (a name from `ace_machines`) to act in that machine's ace browser, for example to test a dev server running there.
