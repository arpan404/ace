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
setting keeps the app anyway. Quit is explicit and unchanged: the backend closes every view,
waiting for them (Electron does not finish quitting with a page alive), within the existing
two-second grace.

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

The daemon still emits `browser.backend.lost` with `pageStateLost: true` when the link drops;
after a re-adoption that is pessimistic. The daemon's tab runtime (H1) may report the adopted
state instead.

### A slow command fails alone

A relay command that misses its deadline now rejects alone. The relay then sends one liveness
ping, `cdp` method `ace.ping`, with a 5-second deadline, outside the command slots. The desktop
answers it from the main process without touching the renderer. Only a missed ping, or an
answer of `Unknown browser session`, loses the session and closes the view as before. Any
other answer, including an older desktop's "unknown method" error, counts as alive.

### Several native tabs per thread

`EmbeddedPageGroup` holds up to 16 tabs (ADR 0083's per-thread limit), each its own
`WebContentsView` in the thread's partition, sharing the controller lease. Only the selected
tab is placed in the panel or takes the person's input; the others render, unseen, in the
parking window while an agent drives them (`backgroundThrottling: false`, ADR 0069's 30-second
rule), and are hidden and throttled otherwise. Only the selected tab's screencast is relayed.
The `cdp` operation's tab methods, for the daemon's tab runtime:

| Method            | Params                                     | Result                                 |
| ----------------- | ------------------------------------------ | -------------------------------------- |
| `ace.tabs.list`   | none                                       | `{activeTabId, tabs}`                  |
| `ace.tabs.open`   | `{select?: boolean}` (default: background) | `{activeTabId, tabs, tabId}` (the new) |
| `ace.tabs.switch` | `{tabId}`                                  | `{activeTabId, tabs}`                  |
| `ace.tabs.close`  | `{tabId}`; the last tab cannot be closed   | `{activeTabId, tabs}`                  |
| `ace.tabs.resize` | `{tabId, width, height}` (100 to 4096)     | `{activeTabId, tabs}`                  |
| `ace.tabs.cdp`    | `{tabId, method, params?}`                 | the CDP result of that tab             |

A new tab never navigates on its own: the daemon installs its guard (seen through
`ace.tabs.changed`) and then navigates it with `ace.tabs.cdp` `Page.navigate`. Tab events
arrive as `ace.tabs.event {tabId, method, params}`.

### Crashed renderers back off

A crashed renderer reloads at once, then after 2 seconds; a third crash within a minute stops
the automatic reloads (`CrashBackoff`). The page then stays, crashed, and the desktop sends
`ace.rendererCrashed {crashes, reason}` instead of `Inspector.detached`, so the daemon does not
recreate and reload it into another crash. Commands to a crashed page fail at once, except
`Page.reload`, which tries again.

### Placement and focus

A window resize, maximise, full-screen change or restore re-applies the views placed in that
window once it settles, and the renderer measures the page area once more 150 ms after its last
resize event, so a layout that settles late still moves the view onto its frame.

⌘L and ⌘F pressed in a native page no longer move the OS focus at once. The view keeps the
keys typed next (for at most a second) while the app's page focuses its field; the field
asks for the keyboard (`browser.focus-app`), and the main process focuses the app's page and
replays the kept keys into it, in order. If the field never asks, the app takes focus after
300 ms anyway. The first characters typed after ⌘L reach the address bar.

## Verification

Unit tests: `appLifetime`, `CrashBackoff`, `FocusHandoff`, `PausedRequests`, the page group's
tab rules, and the backend's orphan, adoption, expiry and Quit paths. Process tests against
the daemon's real relay over a local socket: a reconnect re-adopts the view without
navigating; a slow command fails alone without losing the page; a command whose view also
misses its ping loses the page. Electron e2e (`ACE_E2E_ELECTRON=1`): closing the last window
keeps the page alive and reopening shows it without a reload; placement after a resize matches
the frame; a second tab renders while not selected; a reconnect re-adopts the page with a
working fresh debugger; a page that keeps crashing stops reloading until reloaded by hand;
Quit exits with parked views.

Not covered by tests: the Background wiring (no app window in tests), the tray on Windows and
Linux, and the 10 px offset the owner saw once, which was not reproduced. The resize re-apply
and the late re-measure address the two ways found for a view to keep a stale box after a
resize; whether either was the one seen needs checking in the running app.
