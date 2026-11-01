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
  Archived threads, Keyboard shortcuts and Connection; Usage moved to the rail, see below). Each place is a bare glyph in a
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

_Superseded on 2026-11-01 by "Threads panel: Active on top" below: the Inbox overlay, ⌘I and the
settled grace period are gone._

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

## Threads panel: Active on top

_Superseded later on 2026-11-01 by "Threads panel: Inbox, Snoozed, Settled" below: the project
tree, Show more, quiet projects and the panel's ways to History are gone._

2026-11-01, the owner's choice after trying the Inbox overlay (and turning down a "Working"
overlay in its place). Nothing floats over the list any more; the panel says what is in hand at
its top.

- **Active** is one flat section at the top: every unsettled thread across projects and
  machines, each row with its project's mark. Pinned threads lead it, then what needs the person
  (requests and unseen failures), then what is at work (the thread or its agent tree works or
  waits, or a background command runs), then the rest by last activity (the default sort,
  Live activity; Newest first and Manual keep their own order). Finished work not yet opened says Done on its row here. Membership
  is the daemon's settle facts read through the row attention (`homeTree` in ui-core), so a
  thread whose tree still works or asks is Active even if it was settled, and never sits in a
  project or History.
- **Projects hold only settled threads**, newest first, five then Show more; the ones the daemon
  holds back are one row away, "N more in History". A project's mark is a quiet count of its
  Active threads, never a second needs-you dot. Projects with no thread at all are quiet.
- **No Inbox, no ⌘I, no grace period.** The bell, the overlay and its shortcut are gone (⌘I is
  unbound). With settled threads always in their project, "Keep settled threads in their
  project" left Settings; `threads.keepSettledFor` stays in the settings schema, unread, so
  settings files that set it still parse.
- **Chats reads the same way:** Active chats on top (pinned, needs you, at work, the rest), then
  settled chats by day. Its title row lost the bell; New chat is its one action.
- The rail's Threads and Chats dots keep their rules.

## One set of panel pieces

Same day. Every place's panel (Threads, Chats, Skills, Automations, Settings, GitHub) is built
from `components/ui/panel.tsx`: the title row with 32px actions, the search field, section labels
and the one-line panel row with its hover and current fills. Skills and Automations moved onto
them (Automations' rows became one line; its search is always shown, like Chats'), and Settings
followed. GitHub's list pages lost their Inbox / Pull requests / Issues switch: the panel is the
way between them, and it marks the list a pull request or issue page belongs to (Inbox when the
page was opened from it).

## Three-line Active rows, New thread beside Search, no History row

Same day, from the owner's notes on the running app.

- **Active rows are three lines again**, as the sidebar's task rows were before the unified
  frame: line 1 the project's mark and name … the status word with its elapsed time ("Approve",
  "Working 4m", "Waiting 3h", "Failed", in the status colours) or the age at rest; line 2 the
  title; line 3 the branch · PR … the machine's mark with more than one device connected, and
  the provider glyph with its account bubble. 80px, 12px side padding, 4px between rows. The
  status word reads the same row attention as everything else, so a tree that still works or
  waits never reads Done. Hover or focus puts Snooze, Settle and ⋯ beside the status, which
  stays. Pinned rows, settled rows in their projects, snoozed rows and chats stay one line with
  their one mark.
- **New thread moved into the title row**, as a pencil after Search: "ace ▾" … Search, New
  thread. Same behaviour (it asks for a project when there are several, Shift starts in the
  current one, the `newThread` shortcut); the full-width New thread row is gone.
- **No History row at the panel's foot.** History opens from each project's hover action
  (prefiltered), a quiet project's row, the palette and its route; the foot's settled count went
  with the row.

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
  panel's strip is part of the top bar (see below); the strip keeps full view and the dock
  choice.
- **Side panel strip in the top bar** (owner, 2026-11-01, after the unified frame first put the
  strip in a second row on the canvas). While the side panel is docked open beside the column,
  the panel runs the window's full height and its strip is the top bar's part above it: the bar
  splits at the panel's edge, the column's part keeping the title, ⋯ and Work/Summary, the
  panel's part holding its tabs, +, the tab list, full view and then the panel's toggle at the
  far right. The split follows the panel's edge as it is resized, and the panel's content starts
  right under the bar. The strip stays inside the panel's region, so the panel's tabs are found
  in its landmark, and F6 and Tab reach the main header, then the strip, then the panel's
  content. Its empty space drags the window; on Windows it, not the header, clears the caption
  buttons (the column holding the header is marked `data-beside-panel`). In
  full view the strip takes the whole bar, led by back, forward and the sidebar toggle while
  the sidebar is hidden. Docked at the bottom, the strip heads the panel as before and the
  toggle stays at the header's right.
- **Docked at every size** (owner, 2026-11-01, replacing the floating panel at 896px and below
  and the phone's sheet). The side panel never floats over the chat, never opens as a sheet or
  modal and never dims anything. One pure rule (`apps/web/src/lib/shell-room.ts`) shares the
  window's width: from 640px up the panel docks beside the column with its strip in the top bar,
  the sidebar stepping aside first (at 1100px and below while the panel is open, or wherever it
  would leave the column and the panel under their minimums), then the panel narrowing towards
  320px while the column keeps 360px; below that the panel caps its width rather than cover the
  column. Widths follow the window continuously; the dragged width is remembered unclamped and
  drawn again once there is room. Below 640px (a phone, never the desktop app, whose window is
  at least 768px) the panel takes the canvas in the column's place, as full view does, its
  strip led by Back to chat, with no full view or toggle; focus moves into it and Back hands
  focus to the header's toggle, so the keyboard never rises. A bottom dock stays a split under
  the column at every width.
- **Boundary markers in the top bar** (owner, 2026-11-01). The bar carries a short hairline
  (1px `--border`, 20px, centred) where the sidebar meets the column and where the column meets
  a panel docked beside it, on the edge the canvas's hairline runs down, so the bar reads in
  the same columns as the canvas. Each shows only while both parts beside it are there (none in
  full view or on a phone), follows its edge as it resizes, is `aria-hidden` and takes no
  pointer, leaving the bar draggable.
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
- **One-line rows** (Active's unpinned rows went back to three lines; see above). Every row is one `--row-height` line of 14px text. Its right edge carries at
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
  (chats-circle, filled while current); Threads takes the folders glyph
  (Phosphor Folders, filled while current), since that place is the projects list. Chats has its own
  route, `/chats` (it opens the top chat, or says "No chats yet"); a chat opens at its usual
  `/t/<id>`. The rail decides between the two from the open thread: Chats while a chat or New
  chat (`/new?project=chat`) is open, Threads for any other thread. It reads the thread id from
  the address itself and the thread from the list, else from the open thread's own details, so
  it never shows both places current while the address changes. `g c` goes to Chats, and the
  palette's Go to lists it.
- **Dots per place.** Each place's dot comes from its own threads, by the same row attention
  every row reads: the warning colour while one needs the person (its name and tooltip say how
  many), blue for a failure or finished work not yet opened.
- **Chats panel.** Its title row is "Chats" and New chat (the Inbox bell left it on
  2026-11-01), which opens New thread with no project straight away (the existing chat-creation
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
- **Every machine.** Chats run on a machine like any thread ([ADR 0102](0102-work-on-another-machine-in-this-window.md)).
  The panel lists every connected machine's chats; each row acts on its own machine and names
  it as Threads rows do (spoken name and hover card). With more than one device the title opens
  a device filter kept apart from Threads' (`chatDevice` in the organizer); it narrows the list,
  the search (this daemon's search isn't asked while another device is chosen, as in Threads)
  and the paging, and an empty device reads "No chats on <device>" with "Show all devices".
  New chat starts on the chosen device, else this machine, and makes the chat project there;
  New thread's "on <device>" line moves it before sending. Other machines' chats that need the
  person reach the Chats dot. While a chat is open the top
  bar shows a chat bubble before its title instead of the project's folder.
- **Threads leaves chats out** of Active, its projects, its quiet projects, its History and its
  search hits. Move to project moves a chat into Threads.

## Threads panel: Inbox, Snoozed, Settled

2026-11-01, the owner's choice after trying Active on top with settled threads in their projects
(prototype `inbox-approved`). With many agents on many machines, the project tree made the person
scan folders to find what wanted them, and what was "done" lived in a different shape from what
was open. The panel now reads like mail: every thread is in one of three places, and the order
says what to do next.

- **Three tabs** under the title row: **Inbox · Snoozed · Settled**, text tabs, the open one on
  the `--active` fill; Inbox and Snoozed carry a quiet count. The open tab is kept per device
  with the organizer (`Organizer.tab`). 1, 2 and 3 switch them from anywhere in the panel.
- **One flat Inbox by urgency.** Every unsettled, unsnoozed thread across projects and machines,
  in the order the person would act: pinned; needs you (a request, an unseen failure); running
  (the whole agent tree counted); finished but unseen; idle. Each band is newest first. There
  are no headings: the row's own status word says why it is where it is, and a heading would
  repeat it. Newest first and Manual (Sort threads) keep the person's order below the pinned
  threads. Placement reads the row attention (`threadsPanel` in ui-core), so a settled thread
  whose tree still works or asks is in the Inbox, and a band never disagrees with its row.
- **Snoozed** lists what waits for a time or an event, soonest first; each row says "until …"
  where its status sits. **Settled** lists settled threads at rest, newest first, in muted
  titles; it pages up to 100 as it scrolls, then points to search (⌘K) for older ones.
- **Projects and devices are a filter, not the structure.** The title reads "Threads"; beside it
  "Everywhere ▾" is the project and device filter the "ace ▾" caret used to open, and it narrows
  all three tabs. The project tree, Show more, Quiet projects and the per-project History links
  are gone. History stays as a page (`/history`), reached from the palette and its route.
- **Rows** are the three-line task rows in every tab, pinned ones too (with a small pin glyph).
  Hover keeps Snooze, Settle or Unsettle and ⋯. Settle and snooze confirm in a toast with Undo,
  as archive and move already did; E settles the focused row and H opens its snooze menu.
- **Event-based snooze.** Besides the times, the snooze menu offers **Until it needs you** for a
  live thread (it returns the moment its tree asks for an approval or an answer, fails or
  finishes) and **Until the PR changes** when it has a confirmed pull request (a new review or
  comment, a push, or checks finishing). Waiting on the thread is the point of most snoozes; a
  time only guesses when that will be.
  - The command carries the event (`thread.snooze` `wake`); the daemon stores it with the snooze
    as `snoozeWake` (for a PR, each linked PR's `updatedAt`, head, state and check roll-up at
    that moment) and refuses one that can't apply (`snooze_not_live`, `snooze_no_pr`).
    `snoozedUntil` stays as a 30-day backstop, so every reader of snoozes keeps working and
    nothing sleeps for good.
  - The wake is a pure rule (`snoozeWakeDue` in `@ace/projection`) that the daemon's organizer
    applies whenever a thread's status, queue or details change, and to every thread when it
    starts, so a wake missed across a restart still happens. The GitHub state refresh now reads
    each linked PR's head commit and check roll-up for it.
  - **Safety first (priority 1).** A snooze waiting on an event never hides a need: ui-core's
    `isSnoozed` reads the same rule, so the row returns before the daemon's wake even arrives,
    and the needs-you counts and notifications leave out only snoozes to a time the person
    chose (`isSnoozedToTime`). The rail's Threads dot already counted snoozed threads that need
    the person and still does; a request always shows in the Inbox, whatever the snooze.

## Usage in the rail

2026-11-01, owner-approved design (mockups `usage-approved`, icon option B). Usage left the
profile menu and became a place in the rail's foot, above Settings (after the app's update).

- **The glyph is the state.** A tiny bar chart, one bar per provider used in the last seven days
  (at most four, most used first), each as tall as that provider's pooled session left: the
  best account's session left, capped by that account's weekly window, because ace can start a
  new thread on whichever account has room (`usageHeadroom` / `railUsage` in ui-core). Bars are
  foreground ink, amber under 20%, red at 0 with a short stub so a spent provider never
  vanishes. With nothing read, the empty tracks show quietly. Its spoken name says the state
  ("Usage: Claude Code 38% of session left, Codex 62%").
- **Hover or focus opens a card** (`glass-thin`): one sentence on the tightest provider (its
  forecast from the pace so far, its reset), then per provider the account new threads use, its
  account count, and Session and Weekly mini bars; "Updated … ago" and "Open Usage ›". It reads
  the app's live accounts subscription; the seven-day ranking is read again only when a limit
  changes, never on a timer.
- The rail marks Usage current on `/usage`. The page is one scroll: Now, Limits, Spend, Tokens
  and Where it went, cardless, with a row in Where it went filtering the whole page.

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
