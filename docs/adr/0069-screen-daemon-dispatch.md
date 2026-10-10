# 0069: Screen session dispatch and window acquisition

Date: 2026-10-07. Status: accepted.

## Decision

The helper owns native window identity. App acquisition asks `windows.list` for
candidate windows and its resolved `selectedWindowId`. An explicit window ID is
accepted only from that app's usable candidates. An ambiguous acquisition fails
before input dispatch and returns candidates. Agents can recover with
`screen_open_app` plus `windowId`, then use `screen_select_window` to change the
same app session. Windowless apps retain semantic sessions after seven readiness
queries, with delays of 25, 50, 100, 200, 200 and 200 milliseconds. No retry waits
when the helper already has a usable resolved window.

Actions and accessibility observations share a bounded queue per session.
Eight host operations can run concurrently, with 160 admitted operations and at
most sixteen actions/observations admitted per session. The helper request map
still caps in-flight requests at 32. Foreground actions, including clipboard paste, use a separate shared lane.
Background paste uses native AX delivery and stays in its session lane. Background work in another app cannot delay authority
checks for a queued action in this session. Authority is rechecked after queued
work and immediately before native dispatch. Takeover cancels queued work;
already dispatched input can finish.

Helpers advertising `permissionEvents` supply permission facts at session startup. The daemon caches
those facts and updates them on `permissions.changed` notifications. Native
input must still check OS permission at dispatch. A native permission denial
invalidates the cache. Helpers without permission-event support retain per-action
permission inspection. Permission revocation stops capture when Screen Recording
is lost and rejects further input when Accessibility is lost.

Tools reuse a helper-provided settled snapshot. Older helpers without that result
receive one fallback observation. `screen_open_url` opens an app URL or deep link
in the approved app, and `screen_menu` invokes its menu path through accessibility.
The input schema advertises accepted macOS named keys and modifier aliases.
Authored helper errors retain their specific code and dispatch phase. Dispatch
phase is one of `rejected-before-dispatch`, `dispatched`, or `partial`; callers
must inspect the destination before repeating a dispatched or partial action.
The result-rendering workstream owns sanitized error detail and typed results.

## Browser startup defect

Headless launch owns a separate Chromium guardian process. Release builds omitted
its entry point and did not rewrite the runtime URL. Source-tree launch tests
passed, while a built daemon failed with `Chromium guardian exited before launch`.
The release builder now stages `browser-process-guardian.mjs` and rewrites that
URL. Browser launch errors retain their original cause if guardian cleanup fails.
Packaged tests exercise the process edge and repeated `ace_browser_open` against a
local page in an isolated headless profile.

## Integration requirements

The native helper's `window.select` must replace capture and accessibility target
atomically and fence callbacks from the former target before acknowledging. It
must retain monotonically increasing frame sequences for the same session.
The native helper workstream owns this operation and permission-change events.
It advertises `windowSelection` and `permissionEvents` only when those contracts
are implemented. Older helpers use inventory and fresh permission inspections.
This daemon workstream uses those additive operations and retains safe fallback
selection for older helpers that can enumerate only one unambiguous window.

## Measurements

The fake-helper benchmark adds 10 ms to each request and returns a settled tree
with the native action. Ten samples per action, excluding startup, produced these
non-gating medians in milliseconds against commit `88805977`.

| Tool            | Before | After |
| --------------- | -----: | ----: |
| `screen_key`    |  35.57 | 11.92 |
| `screen_type`   |  34.01 | 12.08 |
| `screen_click`  |  34.04 | 11.97 |
| `screen_scroll` |  36.64 | 12.42 |
| `screen_paste`  |  34.97 | 12.24 |

These measure daemon round trips with a controlled fake, not native input speed.
The shared host was under high load. The native-helper worker owns real fixture
measurements; no real-helper timings are claimed for this daemon worktree.

## Amendment: helper selection fallback, 2026-10-10

If a helper does not advertise window selection, `screen_select_window` and
`screen_open_app` with a different window stop the existing capture and start a
replacement on an enumerated, usable window of the same approved app. Ownership
is rechecked after enumeration. Capture-stop acknowledgement fences the old
frames, and the result returns the replacement session ID. Callers must use that
ID for subsequent explicitly scoped requests. Helpers with atomic native
selection retain the existing session ID.
