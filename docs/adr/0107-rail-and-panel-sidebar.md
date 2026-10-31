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

## Threads panel: Projects, with the Inbox over them

Same day, after rejecting a list grouped by time (Needs you, Running, Today, Yesterday…) with
Active and Settled tabs, the owner chose a panel grouped by project. This reverses the earlier
rule that the thread list is never grouped by project. A first build drew the Inbox as a section
above the projects, with Running and Recent places and focused drill-in lists; after trying it in
the app the owner replaced that with the design below (round six of the mockups, "Current").

- **Projects are the panel's whole body.** Each project folds open in place with its open
  threads, running ones first (Sort threads, Manual drag within the project and pins still
  apply), then the threads it settled recently, dimmed. Projects with nothing open, waiting or
  recently settled fold under Quiet projects, each opening its History. There are no Running or
  Recent places and no drill-in lists.
- **The Inbox is an overlay.** A bell in the panel's title row (and ⌘I, from any place) opens it
  over the list. It holds only what needs the person: requests, unseen failures and finished work
  not yet opened, newest first, read from the same row attention every row draws, so it never
  disagrees with a row's status word. No thread shows in both the Inbox and its project. Its rows
  only open their thread; answering and approving happen in the thread. Opening a finished thread
  marks it seen and it leaves the Inbox. The bell's badge counts it; the rail's Threads dot keeps
  its needs-you count.
- **Settled threads fade into History.** A settled thread stays in its project, dimmed, for a
  grace period the person chooses, then shows only on the History page and in search. The period
  is a daemon setting beside Sort threads, `threads.keepSettledFor` (`1d`, `3d` by default, `7d`,
  or `0d` for straight to History), so every device on the machine agrees. A settled thread whose
  agent tree still works or waits is never dimmed or sent to History: it shows as open work.
- **History** is a full main-column page (`/history?project=`): settled threads grouped by week,
  a search (the daemon's search for older ones) and a chip per project. It is reached from a row
  at the panel's foot, each project's hover History and the palette; the rail keeps Threads
  current while it shows.
- The tree's folds are kept per device with the rest of the organizer state; the Inbox's
  open state is per window and starts closed.
- The daemon pages settled threads across every project together. The panel loads pages back to
  the grace period's boundary on its own; History loads older pages as it scrolls. Each project's
  count of held-back settled threads comes from the daemon's per-project totals less the open
  threads it has already sent, so a project known only from them still shows as quiet.

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
