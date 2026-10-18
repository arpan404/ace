# 0085: The desktop's native pages outlive windows, links and slow commands

Date: 2026-10-17. Status: accepted. Amends [ADR 0055](0055-browser-backends.md),
[ADR 0069](0069-shared-native-browser.md) and [ADR 0083](0083-browser-v2-daemon-chrome.md).

## Context

The owner chose a hybrid browser: the desktop's Electron `WebContentsView` stays the primary
in-app renderer (it paints at the display's refresh rate), ace's own Chrome is the background
and fallback engine, and "Use my Chrome" comes separately (ADR 0084). ADR 0083 had planned to
delete the embedded backend; under the hybrid it stays, so its lifecycle has to be one a real
browser would have. It was not:

- Closing the last window made the app stop offering the backend, which closed every view.
  On Windows and Linux the app then quit and stopped the daemon it started, killing working
  agents.
- Any socket blip between the desktop and the daemon closed every view; the daemon reopened
  each page and navigated it again, losing its state.
- One command that took longer than its relay deadline (30 s) lost the whole page.
- A thread had one native tab.
- A renderer that crashed while reloading lost the page, and the daemon's recreation could
  crash it again, in a loop.

## Decision

### Views live with the app, not with a window

The backend is offered as soon as a local daemon runs, with or without a window. A view made
with no app window open starts in the hidden parking window (ADR 0069), and a closing app
window moves its views there before it goes (`EmbeddedViews.evacuate`). A renderer that
places a thread's page again takes the same view back, unreloaded. Switching threads or
hiding the panel only hides a view (verified: neither path closes or reloads one).

The parking window no longer decides when the app quits. A pure rule (`appLifetime`) does:
with no window, macOS stays open as before; Windows and Linux stay running, with the tray icon
as the way back in and out, while any thread has a native page or any agent works (the
daemon link's work summary), and quit as before once neither holds, unless the background
setting keeps the app anyway. Quit is explicit: the backend closes every view,
waiting for them (Electron does not finish quitting with a page alive), within the existing
two-second grace. Amended for #952: while agents work and one of them read or acted in a native page in the
last minute (`quitNeedsConfirmation`), Quit asks once ("Agents are using the browser": Quit or
Cancel). Nothing asks otherwise, nor during a system shutdown.

### Re-adoption after a lost link

A lost backend socket no longer closes views. `BrowserBackend.detach` keeps each page as an
_orphan_ for ten minutes, by thread. An orphan refuses the loads the daemon's origin guard has
paused and any it pauses later (`Fetch.failRequest` with `BlockedByClient`, also inside
non-flattened frame targets): with no daemon nothing can approve them, so they fail closed.

The protocol is unchanged on the wire and stays lenient:

- When a registered daemon sends `open` for a thread that has an orphan with the same workspace
  and profile, the desktop _re-adopts_ it instead of creating a view. The page gets a fresh
  debugger session (the old one is detached and a new one attached, so nothing paused,
  captured or emulated survives) and the open result carries `adopted: true` next to the usual
  `url`, `activeTabId` and `tabs`. The document, scroll and form state are untouched.
- The daemon's embedded relay treats an adopted session's first navigation to the URL it was
  adopted at as already done, so recovery (`resume`: open, then navigate to the last URL) does
  not reload the page. Any other command first ends that allowance.
- An older daemon ignores `adopted` and navigates as before; an older desktop never sends it.
  A crashed orphan, a different profile or an expired orphan gets a fresh view.

The daemon does not report a dropped link at once. The thread pauses (paused, no
`pageStateLost`) and waits up to 10 seconds (`desktopReadoptionGraceMs`) for the desktop to come
back; agent work that wants the page meanwhile waits too, instead of moving it to ace's Chrome.
A re-adoption resumes the thread on the same pages with nothing reported lost. Only when the
grace passes, or the desktop comes back with a fresh view, does the daemon emit
`browser.backend.lost` with `pageStateLost: true` (and, under the `headless` loss policy, move
the page). A view that dies while the link stays up is reported at once. Re-adopted tabs get a
fresh CDP session, so the daemon removes any annotation overlay the lost link left in the page
(found by its isolated world when Runtime is first enabled) before anything installs a new one.

### A slow command fails alone

A relay command that misses its deadline now rejects alone. The relay then sends one liveness
ping, `cdp` method `ace.ping`, with a 5-second deadline, outside the command slots. The desktop
answers it from the main process without touching the renderer. Only a missed ping, or an
answer of `Unknown browser session`, loses the session and closes the view as before. Any
other answer, including an older desktop's "unknown method" error, counts as alive.

### Several native tabs per thread

`EmbeddedPageGroup` holds up to 16 tabs (ADR 0083's per-thread limit), each its own
`WebContentsView` in the thread's partition. Only the selected
tab is placed in the panel or takes the person's input; the others render, unseen, in the
parking window while an agent drives them (`backgroundThrottling: false`, ADR 0069's 30-second
rule), and are hidden and throttled otherwise. Only the selected tab's screencast is relayed.
The `cdp` operation's tab methods are the one tab contract the desktop and the daemon's tab
runtime (ADR 0083) both keep:

| Method            | Params                                    | Result                                 |
| ----------------- | ----------------------------------------- | -------------------------------------- |
| `ace.tabs.list`   | none                                      | `{activeTabId, tabs}`                  |
| `ace.tabs.open`   | `{select?, tabId?}` (default: background) | `{activeTabId, tabs, tabId}` (the new) |
| `ace.tabs.switch` | `{tabId}`                                 | `{activeTabId, tabs}`                  |
| `ace.tabs.close`  | `{tabId}`; the last tab cannot be closed  | `{activeTabId, tabs}`                  |
| `ace.tabs.resize` | `{tabId, width, height}` (100 to 4096)    | `{activeTabId, tabs}`                  |
| `ace.tabs.cdp`    | `{tabId, method, params?}`                | the CDP result of that tab             |

- **Opening.** The daemon sends `select: true` only when the new tab should take the person's
  view (they opened it, or an agent did while they had not picked a tab). A new tab is blank and
  never navigates on its own: the daemon installs its guard (seen through `ace.tabs.changed`)
  before `ace.tabs.open` returns to the caller, then navigates it with `ace.tabs.cdp`
  `Page.navigate`.
- **Driving.** Every tab, shown or not, takes input, navigation, screenshots and printing through
  `ace.tabs.cdp`. Tab events arrive as `ace.tabs.event {tabId, method, params}` (the daemon
  logs each tab's console calls and network requests from them, by tab); popups as
  `ace.popupRequested {url, tabId}`, run in the opener's queue.
- **The shown tab only.** Whether an agent uses the tab (`agentUse`, amended 2026-10-17 for H4:
  the controller lease is gone and the person's input always reaches the shown view; the view
  reports it to the daemon as `ace.humanInput`), native key presses (`press`) and the panel's
  size apply to the selected tab. The daemon says whether an agent uses the shown tab, and says
  it again whenever the shown tab changes. Unseen tabs always count as the agents':
  the person cannot reach them. An unseen tab takes CDP key events and is sized with
  `ace.tabs.resize`.
- **Closing.** Any tab but the last; the last goes with the browser.
- **Restoring** (#946). `tabId` on `ace.tabs.open` asks for that id, granted when it is free:
  the daemon reopens a thread's recorded tabs in fresh views with the ids they had, then
  navigates each. The blank first view gives way to them (or is reused when it already has the
  first id). An older desktop ignores `tabId`.

### Crashed renderers back off

A crashed renderer reloads at once, then after 2 seconds; a third crash within a minute stops
the automatic reloads (`CrashBackoff`). The page then stays, crashed, and the desktop sends
`ace.rendererCrashed {crashes, reason}` instead of `Inspector.detached`, so the daemon does not
recreate and reload it into another crash. Commands to a crashed page fail at once, except
`Page.reload`, which tries again. The daemon lists the tab with lifecycle `crashed` and refuses
agent work there with `tab_crashed`, except a reload or a navigation: a navigation first asks
for the reload and waits for `ace.rendererRestarted` to re-arm the tab.

### Placement and focus

A window resize, maximise, full-screen change or restore re-applies the views placed in that
window once it settles, and the renderer measures the page area once more 150 ms after its last
resize event, so a layout that settles late still moves the view onto its frame.

Amended 2026-10-18: a native view paints above the app's own menus, so a menu over it hides
the view in place and draws the view's still there first. The placement is then marked
`covered`: the page counts as watched, so it renders (parked) and its sound plays, and the
renderer draws the live screencast in its place once a fresh frame arrives, so a playing video
keeps moving under the menu. Only what paints above the view covers it: a portal at a higher
z-index, or a later one at the same z-index. Picture-in-picture is a portal itself, so the app
beneath it never covers it. Picture-in-picture opening by itself is a per-device setting
(Settings › Browser › Picture in picture), on by default.

⌘L and ⌘F pressed in a native page no longer move the OS focus at once. The view keeps the
keys typed next (for at most a second) while the app's page focuses its field; the field
asks for the keyboard (`browser.focus-app`), and the main process focuses the app's page and
replays the kept keys into it, in order. If the field never asks, the app takes focus after
300 ms anyway. The first characters typed after ⌘L reach the address bar.

## Verification

Unit tests: `appLifetime`, `CrashBackoff`, `FocusHandoff`, `PausedRequests`, the page group's
tab rules (agent use reaching only the shown tab, the person's input reported with its tab), and the backend's orphan, adoption, expiry
and Quit paths. Process tests against the daemon's real relay over a local socket: a reconnect
re-adopts the view without navigating; a slow command fails alone without losing the page; a
command whose view also misses its ping loses the page; the daemon's whole tab runtime
(`BrowserService`) drives two native tabs at once, a slow tab holding up neither the other nor
the view, keys going natively to the shown tab and as CDP to the unseen one, and the shown
view learning whether an agent uses it as the person moves between tabs
(`relay-tabs.process.test.ts`). Daemon
process tests: a dropped link waits for re-adoption before reporting the page lost; a re-adopted
real Chrome page keeps its document, reports nothing lost and loses the stale overlay
(`readoption.process.test.ts`); a crashed tab refuses work until a navigation revives it. Electron e2e (`ACE_E2E_ELECTRON=1`): closing the last window
keeps the page alive and reopening shows it without a reload; placement after a resize matches
the frame; a second tab renders while not selected; a reconnect re-adopts the page with a
working fresh debugger; a page that keeps crashing stops reloading until reloaded by hand;
Quit exits with parked views.

Not covered by tests: the Background wiring (no app window in tests), the tray on Windows and
Linux, and the 10 px offset the owner saw once, which was not reproduced. The resize re-apply
and the late re-measure address the two ways found for a view to keep a stale box after a
resize; whether either was the one seen needs checking in the running app.
