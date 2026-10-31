# 0107: Rail and panel sidebar, with Spade shown as coming soon

Status: accepted. Date: 2026-10-31. Owner decision of 2026-10-31, after three rounds of mockups.

## Context

The web and desktop sidebar was one column: the ace wordmark and Search at the top, the thread
list, and a foot row with the profile, the GitHub button and the Settings gear. Automations and
Skills sat in the profile menu. Opening Settings, Automations or Skills switched the sidebar into
a second mode: app navigation and the profile were hidden and a "Back to app" row took the foot.

That mode switch hid where the person was and how to get elsewhere, and the places other than
Threads had no stable home. A new place is also coming: Spade, a cloud agent with ace as its
front end, which is not live yet.

## Decision

- **Rail + panel.** The sidebar is a 52px rail of places beside a panel that shows the current
  place. Top to bottom the rail holds Threads, Spade, GitHub, Automations and Skills; then free
  space, the app's update when there is one, Settings and the profile avatar (its menu keeps
  Usage, Archived threads, Keyboard shortcuts and Connection). Each place is a bare glyph in a
  36px rounded box; the current one takes the `--active` fill. The rail's top is the window's
  drag area, where macOS draws the traffic lights.
- **Each panel owns its header.** The panel's top row is the place's title and actions, level with
  the main column's header. Threads shows the thread list; GitHub lists Inbox, Pull requests and
  Issues (the pages stay full main-column pages); Settings, Automations and Skills draw their
  own lists through `ViewFrame` as before.
- **No more Back to app.** The rail is always there, in every place, so the second sidebar mode
  is gone. Threads in the rail returns to the thread the person last had open.
- **Threads' needs-you signal.** While the person is in another place and any thread needs them
  (the thread list's own rule: a needs-you status), Threads shows a dot in the needs-you colour,
  and its name and tooltip say how many. On Threads the list says it, so the rail adds nothing.
- **Narrow windows.** The sidebar sheet shows the rail and panel together.
- **Spade is shown, not live.** Spade's mark sits in the rail, dimmed, with a small "Soon" pill.
  It is a picture, not a control: it cannot be focused or pressed, has no route, and its tooltip
  says "Spade · Coming soon".
- The panel keeps its drag-to-resize edge (220–480px, 288 by default); the rail is added to it.

## Threads panel: Inbox + Projects

Same day, after rejecting a list grouped by time (Needs you, Running, Today, Yesterday…) with
Active and Settled tabs, the owner chose the Threads panel as an Inbox over a project tree
("C · Hybrid" of the round-five mockups). This reverses the earlier rule that the thread list is
never grouped by project.

- **Inbox** on top holds only what needs the person: requests, unseen failures and finished
  work not yet opened, read from the same row attention every row draws, so a group never
  disagrees with a row's status word. Opening a finished thread clears it.
- **Running** and **Recent** are one-line places that open as focused lists. Running holds every
  thread at work across projects. Recent holds what finished in the last 7 days (settled in that
  window, or done and seen), newest first by day; settled threads page from the daemon only back
  to that boundary.
- **Projects** fold open in place with their other open threads (no thread shows in both the
  Inbox and its project), running ones first, and end with their own "N settled". A project can
  open as a focused list with Active and Settled tabs; projects with nothing open fold under
  Quiet projects.
- The tree's folds are kept per device with the rest of the organizer state; the focused list
  is kept per window (session storage), so a reload returns to it.
- The daemon pages settled threads across every project together, so a project's "N settled"
  and Recent read from the same pages; each project's count comes from the daemon's per-project
  totals less the open threads it has already sent.

## Consequences

- Keyboard shortcuts (`g h`, `g u`, `g s`, `g p`, ⌘,) keep working and move the rail's selection,
  since the selection follows the route. F6 and ⌘\ treat rail and panel as the one sidebar.
- Tests and helpers that went through Back to app or the profile menu's Automations and Skills
  entries now use the rail.
- Wiring Spade's cloud backend into ace needs its own ADR. [ADR 0002](0002-local-cli-providers.md)
  says ace is never hosted and reaches providers only through the person's own CLIs; Spade would
  be a hosted service ace talks to, so connecting it must be decided on its own terms (as
  [ADR 0106](0106-ios-remote-push-gateway.md) did for the push gateway), not slipped in with
  this shell change.
