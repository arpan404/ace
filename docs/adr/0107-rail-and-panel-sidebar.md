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
  40px rounded box; the current one takes the `--active` fill. (The unified frame below moves
  the rail under the window's top bar.)
- **Each panel owns its title row.** The panel's first row is the place's title and actions
  (under the window's top bar since the unified frame below). Threads shows the thread list; GitHub lists Inbox, Pull requests and
  Issues (the pages stay full main-column pages); Settings, Automations and Skills draw their
  own lists through `ViewFrame` as before.
- **No more Back to app.** The rail is always there, in every place, so the second sidebar mode
  is gone. Threads in the rail returns to the thread the person last had open.
- **Threads' needs-you signal.** While the person is in another place and any thread needs them
  (the thread list's own rule: a needs-you status), Threads shows a dot in the needs-you colour,
  and its name and tooltip say how many. On Threads the list says it, so the rail adds nothing.
  (Since Chats below, each of Threads and Chats counts only its own threads.)
- **Narrow windows.** The sidebar sheet shows the rail and panel together.
- **Spade is shown, not live.** Spade's mark sits in the rail, dimmed. It is a picture, not a
  control: it cannot be focused or pressed, has no route, and only its tooltip says
  "Spade · Coming soon".
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
  marks it seen and it leaves the Inbox. The bell's dot says it holds something (the unified
  frame below replaced the count badge); the rail's Threads dot keeps its needs-you count.
- **Settled threads fade into History.** A settled thread stays in its project, dimmed, for a
  grace period the person chooses, then shows only on the History page and in the palette's
  search. The period
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

## Unified frame

Same day, after living with the build, the owner asked for the shell to read as one frame rather
than a sidebar and a column each with its own header.

- **One top bar.** A 44px bar runs across the whole window and is its drag area. At its left,
  after the macOS traffic lights, sit Back, Forward and the sidebar toggle; the title (the
  project's folder glyph, then the thread title or the page name) starts where the main column
  starts, so it follows the sidebar as it resizes or hides; at its right sit ⋯, Work/Summary and
  the side panel's toggle. Built as two halves on the same row: the sidebar's top row carries the
  navigation while the sidebar is beside the column, and the screen header carries it while the
  sidebar is hidden or a sheet. There is no other header row and no hairline under the bar.
- **Frame and canvas.** Only the top bar and the rail sit on the frame colour (`--sidebar`).
  Everything under the bar from the sidebar's panel rightwards is one canvas on the page
  surface (`--background`): it begins at the panel, which turns a 12px corner at its top left
  with a hairline along its top and left, and runs on through the main column and any side
  panel, with one hairline between the panel and the main column (owner, 2026-11-01: the
  sidebar reads as part of the workspace, not part of the chrome). With the sidebar hidden or
  in a sheet, the canvas runs to the window's edge and keeps only its top hairline. The side
  panel's strip sits on the canvas; its toggle stays in the top bar, and the strip keeps full
  view and the dock choice.
- **Rail.** Bare 20px glyphs in 40px boxes; a short hairline divides Threads and Spade from
  GitHub, Automations and Skills. A dot on a place is in the warning colour while something there
  needs the person, blue while it holds news not yet seen (GitHub's unread notifications).
- **Threads panel.** Its title row is "ace" with a caret that opens the project and device
  filter, the Inbox bell (a small dot: warning colour while anything needs the person, else
  blue) and Search, which opens the palette; the panel's inline search is gone, and searching
  threads, settled ones included, happens in the palette and on History. Then a New thread row,
  Pinned threads (each with a chat glyph; a pinned thread waiting in the Inbox stays there), and
  Projects: a folder glyph per project (open while expanded), its threads indented under the
  project's name, five at a time and then Show more. History stays at the foot.
- **One-line rows.** Every row is one `--row-height` line of 14px text. Its right edge carries at
  most one mark, from its attention level: a warning dot (needs you), a failure dot (failed, not
  seen), a blue dot (finished, not seen), or a ring in the status's colour that breathes a few
  times and then holds still (the thread or its agent tree still works or waits; it never loops,
  and holds still under reduced motion). Status words, spinners, branches, pull requests,
  provider glyphs, subagent counts and machine marks left the row for the thread and its hover
  card. Hover or focus puts the row's actions in the mark's place. Because the mark reads the
  same attention as everything else, a thread whose tree still works never shows the finished
  dot.

## Chats

2026-11-01, owner-approved design. Chats ([ADR 0099](0099-chats-without-a-project.md): threads
started with no project, in a hidden chat project) get their own place, so the Threads panel is
about work in projects.

- **Rail.** Chats sits right under Threads, above Spade, with the speech-bubble glyph
  (chats-circle, filled while current); Threads takes the code glyph (`</>`). Chats has its own
  route, `/chats` (it opens the top chat, or says "No chats yet"); a chat opens at its usual
  `/t/<id>`. The rail decides between the two from the open thread: Chats while a chat or New
  chat (`/new?project=chat`) is open, Threads for any other thread. It reads the thread id from
  the address itself and the thread from the list, else from the open thread's own details, so
  it never shows both places current while the address changes. `g c` goes to Chats, and the
  palette's Go to lists it.
- **Dots per place.** Each place's dot comes from its own threads, by the same row attention
  every row reads: the warning colour while one needs the person (its name and tooltip say how
  many), blue for a failure or finished work not yet opened.
- **Chats panel.** Its title row is "Chats", the Inbox bell (the same overlay as Threads') and
  New chat, which opens New thread with no project straight away (the existing chat-creation
  flow; nothing asks which project). Under it, "Search chats". Then one flat list: Pinned, then
  Today, Yesterday, Previous 7 days and Earlier by last activity on this device's calendar
  (`chatList` in ui-core, with the clock passed in). Rows are the Threads list's own: one line,
  one mark, the hover card, the same keyboard, virtualization and motion; their hover actions
  are Rename, Pin, Move to project and Delete, each the thread menus' own action.
- **Settled chats stay by date.** No grace period and no History for chats: a settled chat stays
  in its day, dimmed. One whose agent tree still works or waits is never dimmed, and its mark
  is never the finished dot.
- **Search.** Titles filter as the person types. The daemon's `search.query` can scope to one
  project, not to every chat, so the panel asks it for threads and keeps the hits whose project
  is a chat's (client-side); a hit for a chat the list hasn't loaded joins its day by the
  matching message's time. Esc clears the field.
- **Paging.** The daemon pages settled threads across every project together and cannot page
  chats alone, so while the list's end is in view the panel keeps asking for older pages and
  keeps the chats among them.
- **Threads leaves chats out** of its projects, its quiet projects, its History and its search
  hits. **The Inbox keeps them**: a chat that needs the person or finished unread shows there,
  with "Chat" in place of a project's name. Move to project moves a chat into Threads.

## Consequences

- Keyboard shortcuts (`g h`, `g c`, `g u`, `g s`, `g p`, ⌘,) keep working and move the rail's selection,
  since the selection follows the route. F6 and ⌘\ treat rail and panel as the one sidebar.
- Tests and helpers that went through Back to app or the profile menu's Automations and Skills
  entries now use the rail.
- Wiring Spade's cloud backend into ace needs its own ADR. [ADR 0002](0002-local-cli-providers.md)
  says ace is never hosted and reaches providers only through the person's own CLIs; Spade would
  be a hosted service ace talks to, so connecting it must be decided on its own terms (as
  [ADR 0106](0106-ios-remote-push-gateway.md) did for the push gateway), not slipped in with
  this shell change.
