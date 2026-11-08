# ace design language

What ace looks and feels like on every surface: desktop, web, iPhone (and later Android). It is the layer above [DESIGN.md](../../DESIGN.md): this file says **who ace is and the rules every platform shares**; DESIGN.md turns them into the desktop and web tokens and components; the iOS section below turns them into SwiftUI. When a platform file and this one disagree about a principle, this one wins.

## 1. Who ace is

ace is a calm control room for many agents working at once. The person glances, decides and leaves. So the interface is:

- **Quiet.** Nothing asks for attention unless the person is needed. Work in progress is visible, never loud.
- **Precise.** Every element states something true and current about the agents. If it only decorates or explains the UI, it goes.
- **Native.** On each platform ace feels like the best app built for that platform, not a port. Same language, native grammar.
- **Premium through restraint.** Few values, repeated everywhere. Consistency is what reads as quality.

ace never copies another product's look. It is recognisably itself: grey ink, one coloured status icon, provider marks in their own colours, Spade's face.

## 2. Principles

1. **State, not chrome.** Show what the person acts on: what needs them, what is running, what finished. No labels for things an icon already says, no descriptions of the UI.
2. **One colour job.** Colour means state. Everything else is grey ink in a few tiers. Provider marks keep their brand colours (at 80% in lists); project identity is ink.
3. **Words, not chrome.** A status strip is one short sentence plus text actions. No icons on buttons, no timer glyphs, no tints, no badges where a word works.
4. **No boxes in boxes.** Group with space, weight and one surface step. Never a card inside a card; never a bordered box inside a strip or sheet.
5. **One place per fact.** Each state shows in exactly one place (the row, the strip, or the transcript), never repeated.
6. **Still, not busy.** Nothing loops forever. Live work is a still icon and a running time. Motion only confirms an action or moves something into place.
7. **Correct before pretty.** Never show an agent as done while any part of its tree works or waits.
8. **Fewer values, everywhere.** Every radius, gap, size, colour and curve comes from the token set. A one-off value is a bug.

## 3. Foundations (shared across platforms)

### Ink and colour

- **Ink tiers:** foreground (read this) → muted (secondary) → subtle (meta: time, branch, counts) → faint (decorative only, never words).
- **Status colours** (the only hues in lists), one per state, used only on the status icon and the one sentence that states it:

  | State                                 | Dark      | Light     | Icon                                  |
  | ------------------------------------- | --------- | --------- | ------------------------------------- |
  | Needs you (model, approval, question) | #EDB250   | #AD7200   | sparkle · raised hand · question mark |
  | Failed                                | #F47670   | #C93A33   | warning circle                        |
  | Working                               | #7E9FD6   | #3D63A6   | dashed circle (still)                 |
  | Waiting on agents                     | #A08FD4   | #6A55A8   | dashed circle with the count          |
  | Other wait (queue, recovery)          | #A08FD4   | #6A55A8   | countdown clock                       |
  | Usage limit                           | muted ink | muted ink | gauge, no time                        |
  | Background work                       | #7E8692   | #6B7380   | terminal window                       |
  | Finished, not seen                    | #6CBF8C   | #2E7D4F   | check circle                          |
  | Idle / seen                           | —         | —         | no icon, age only                     |

- **One accent** for the primary action (send, approve, the selected tab's fill). Never decorative.
- Light and dark are equal citizens; every colour is checked at 3:1 against its surface.

### Type

One family per platform (Inter/SF on desktop and web, SF Pro on iOS), five roles, two weights (regular, semibold). Mono only for code, commands, paths and branches.

| Role        | Use                                       |
| ----------- | ----------------------------------------- |
| Large title | A place's name (Threads, Chats, Search)   |
| Title       | Thread titles, message text, sheet titles |
| Body        | Row titles, answers, settings labels      |
| Meta        | Project, branch, time, counts             |
| Caption     | Tooltips, tiny labels                     |

Bold only for emphasis in prose. Rows show attention by brightness alone: what needs the person in full ink, what rests in the muted ink, never by weight.

### Space

A 4-point grid. One side margin per platform (16 on iPhone). Fixed row heights so lists look combed. Group with gaps (8 related, 24 between groups), not dividers.

### Shape

- **Rounded, never sharp, never mixed.** Each platform has a short shape scale and nothing outside it.
- **Concentric always:** a shape inside another follows its curve (inner radius = outer radius − inset).
- **Desktop and web:** the scale in DESIGN.md §2 (4 / 6 / 8 / 12 / 18 / full), with full roundness for pills, Send/Stop, tabs and status marks.
- **iPhone:** full roundness (see §5).

### Materials

Three surfaces only: **background** (flat, where content lives), **glass** (only for things that float over content: tab bar, composer capsule, header buttons, menus), **raised** (sheets, dialogs, anything that holds content above the page). Never glass on glass; never glass on a scrolling area.

### Iconography

Phosphor on desktop and web; SF Symbols matched to the same glyphs on iPhone. One weight per context; status icons filled. Provider marks are the providers' own logos. Spade's mark (round head, two egg eyes, −4° tilt, white eyes in every theme) is the only character in the app. ace's own glyphs are drawn from one shared geometry (`@ace/design-tokens/glyphs`), generated for the phone: the agent cursor, "the Pebble", in the person's accent with its outline and soft shadow, marks computer use; browser use is the globe with the pointer resting on it, in the working colour.

### Motion

Confirm, don't entertain. Only transform and opacity animate. A haptic on send, approve and tab change (iPhone). Respect Reduce Motion. Nothing loops except a startup breath and an indeterminate progress bar while they last. On iPhone, motion is the system's own: navigation, sheets, lists and scroll-edge bars move as they do in Apple's apps, and anything else uses the system's default spring. ace adds motion only where the system has none. Desktop and web arrive with one spring and leave faster than they came.

### Voice

Plain, short, specific. Say what happened and what the person can do: "Codex is out of usage until 9:23 PM", "Claude Code wants to run a command". No internal words (daemon, lease, settle, worktree internals), no exclamation marks, no "please", no marketing. Name buttons by their action ("Allow", "Resume at reset"), never "OK".

## 4. Shared patterns

- **Thread row:** project · status icon (and time for live work) / title (regular weight; full ink when the person is needed) / branch · PR · another machine · provider mark. No status words. The provider mark carries the account's badge only when there is more than one account for that provider.
- **Lists:** one flat list per tab (Inbox · Snoozed · Settled), ordered pinned → needs you → running → finished unseen → idle. No section labels.
- **The composer capsule:** the bottom of a thread is one capsule, as Messages draws it: a round + on its left, then the field and one trailing button. The button is the microphone while the field is empty and nothing runs, Send once there are words or chips, and Stop while the tree works and the field is empty; a typed message still steers or queues. Wrapped words grow the capsule into a rounded shape concentric with its button, up to five lines, then it scrolls. Above it, on the field's left edge: the chips on the next message (files, comments, drawings) as plain capsules, and over them the live pills, one row that scrolls sideways: the status first ("Working · 4m 12s", "Waiting on 2", "Out of usage until 9:23 PM"), then what else is live ("2 subagents", "1 command", "2 queued", "Pursuing goal"). A pill is a capsule on the quiet fill with its still icon in the state's colour and its words in ink; a pill that opens something (the agent tree, the queue, the goal) is a button. Nothing shows when idle. A request strip takes the pills' place and is the only glass above the capsule. The model is not here: it lives in the thread's title (decided 2026-11-04; pills replaced the live line 2026-11-08).
- **Request strip:** leads with the provider mark or status icon, one sentence, at most one line of detail (a command in mono, truncated in the middle), text actions on the right; several waiting show "1 of 3". Anything long (a plan, a question with options) opens in a sheet from "Review".
- **Transcript:** the person's message as a bubble; the agent's work folded under "Worked for 3m 12s"; the agent's last message shown in full. Handoffs, stops and limits are one quiet line each.
- **Empty and loading:** every list has one quiet empty state (a sentence and at most one action) and skeleton rows while loading. Never a spinner in the middle of nothing.

## 5. iPhone

The iPhone app speaks the same language with native iOS 26 grammar.

### Shape: full roundness

- **Every control is a capsule:** buttons, pills, chips, tabs, the segmented control, the search field, the composer's text field, + and Send/Stop, strip actions.
- **Every container is concentric with the screen:** the composer capsule once it wraps, strips, sheets, floating bars and grouped lists use iOS 26 concentric shapes (`ConcentricRectangle` / container-concentric corners) so their curves run parallel to the device's corners.
- **Nested content** inside a container is concentric with it, ending in a capsule at the smallest level (a code line inside a strip, an image inside a message).
- No small fixed radius anywhere.

### Materials

- Liquid Glass (`glassEffect`) only for floating things: the tab bar, the composer capsule and its +, the request strip, Scroll to end, header buttons, the iPad sidebar's places. The live pills are the quiet fill, never glass. Never glass on glass.
- Sheets use the system sheet with detents; menus are system menus; context menus replace inline action rows.

### Structure

- **Tab bar:** Threads · Chats · Search, plus the round compose button. Spade's tab is hidden until it launches; it comes back in its slot between Chats and Search (`HomeTabs.showsSpade`), never as a "coming soon" screen.
- **Compose:** on iOS 27 the tab bar's prominent detached button. On iOS 26, where the detached button belongs to the search tab, Search takes it and compose is a round glass button in the Threads and Chats headers.
- **Header:** large title that collapses on scroll; the scope or a connection problem shows under it only while it applies. On the right, one glass capsule: the scope menu (machine, project, sort, Select) and compose. The system's title menu is not used: it draws no chevron beside a large title. Threads has Inbox · Snoozed · Settled under the title; Chats is its own tab.
- **Avatar:** after the capsule, on its own, the person's avatar as a bare round button, where Apple's apps put the account: the ace account's picture, else their initials on a quiet fill, else a person glyph. It opens one system menu, as the web's account menu: the person first (name, and the account's email or "Not signed in"), opening Profile; then Archived threads and Settings. Signing in and out lives on Profile. Settings stays among Search's Places too.
- **Rows:** an Inbox row is three lines, led by its project. A snoozed or settled thread is one line, as a chat is and as the web draws them: the provider's mark, the title, then its work (pull request, lines changed) at the right; a snoozed row with no work says when it wakes there. A row that needs the person shows its status mark there instead. Every one-line row is the same height.
- **Pinned controls:** a control that stays under a title (Inbox · Snoozed · Settled, a thread's page pills, Search's filters, the pull request chips) is a system bar in the navigation bar's own region, never an overlay or a painted fade. Rows pass under it behind the system's hard scroll edge, which shows once they have scrolled, so a large title at rest stays sharp. The needs-you line scrolls with the list.
- **Search:** replaces More and the web's command palette. Empty, it shows Places as capsules (Pull requests with its open count, Issues, Automations, Skills, Usage, Machines, Settings), recent searches and the latest threads. Typed, it lists actions (each saying where it goes), threads, pull requests, projects and messages. Places open in a sheet; Settings holds every machine tool.
- **iPad and wide windows:** the list sits beside the thread; the sidebar's foot carries the places in the web rail's order (Threads, Chats, Search, then Pull requests, Automations, Skills, Settings) as bare glyphs on one glass capsule, in place of the tab bar.
- **Thread:** the title and, under it, where it is and what runs it: the project's mark and name, then the model and its effort ("▣ ace-next · Opus 5.5 · Med ⌄"). The project's name is cut before the model at any text size; a chat shows the model alone. The two lines are one tap that opens one system menu: the project's mark, its name and the branch first, opening the checkout's Work sheet (a menu's header draws no mark, so this is its row); then Model, Effort and Access; then the thread's own actions. The page pills sit under it, then the transcript, then the composer capsule.
- **Scroll to end:** a round glass caret centred over the composer's foot on the Chat page, shown whenever the transcript's end is more than a few points out of view (or the rows held stop short of it) and gone at the end. It floats over the foot, never part of its height, so showing it moves nothing; a feed following a streaming answer keeps itself at the end, so the button never flickers.

### Interaction

- 44-point tap targets, always.
- Long-press for secondary actions (copy, fork, time), swipe for row actions (pin, snooze, settle).
- Haptics on send, approve, tab change and pull to refresh.
- Motion is the system's. Push and pop, sheets and their detents, menus, list inserts, removals and moves, swipe actions and tab switches are the system's own, with nothing added. Where ace animates, it uses the default spring: a strip or a pill arriving, a disclosure opening, the scroll to the end. A segmented control slides its thumb; what it switches changes at once. A page pill shows its page at once; a swipe between pages follows the finger. Rows highlight on press and never shrink. Changing counts use the system's numeric text transition.
- Nothing animates as a turn streams: streaming text, timers and counts change in place.
- Under Reduce Motion, things that would travel fade in place instead.
- Dynamic Type and VoiceOver: every status icon has its meaning as its accessibility label.

### Tokens

All values live in one Swift design file (shape, spacing, type, surfaces, motion), generated where possible from the shared token source. Views never hard-code a value.

## 6. Desktop and web

DESIGN.md is the full spec: shell, rail, panels, tokens, components and the review checklist. It follows this file's principles and foundations; its shape scale is the desktop's short radius scale with full roundness for pills and status marks.

## 7. How decisions land

- A new pattern is drawn as a mockup first and approved before it's built.
- A decision the owner makes is recorded here (principles and foundations) or in DESIGN.md (desktop specifics), the same day.
- Every UI review checks the change against §2 and the platform's section; a one-off value or a box in a box fails review.
