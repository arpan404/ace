# ace UX audit: why it still feels hard to use

Date: 2026-10-14. Status: proposal, not implemented. Evidence: screenshots, one recording and `metrics.json` in [2026-10-14-ux/](2026-10-14-ux/). Visual style (colour, type, spacing, glass) is out of scope; see [2026-10-14-ui-quality-proposal.md](2026-10-14-ui-quality-proposal.md).

How this was measured: `apps/web` in fake mode (`bun run dev:fake -- --port 5212`), driven by Playwright 1.63 in headless Chromium at 1440×900, 768 and 390 wide. Every number comes from a `requestAnimationFrame` probe, a `PerformanceObserver`, or `document.activeElement` after the action. The dev server is unbundled Vite, so absolute boot numbers are dev numbers; in-app numbers (sends, switches, menus, focus) are representative. Numbers taken while four browsers ran at once are marked _contended_ in `metrics.json` and are not used below.

## What the 2026-10-13 audit asked for, and what is fixed

Checked one by one on current `main` (6d63e518d). Fixed, and verified here:

- **Send is instant.** Message on screen 19 ms after Enter, 0 frames without the composer, CLS 0.0035, composer at the same x/width before and after ([02-new-thread](2026-10-14-ux/02-new-thread.jpg), `metrics.json › new_thread_send`). The Oct 13 blank flash (282 ms) is gone.
- **Esc no longer stops the agent alone.** One Esc shows "Esc again to stop · 2 subagents" ([07d-after-esc](2026-10-14-ux/07d-after-esc.jpg)).
- **Archiving a running thread asks first** ("Archive a running thread? … Cancel / Archive, keep running / Stop & archive"), focus on Cancel ([04g-archive-working](2026-10-14-ux/04g-archive-working.jpg)). Archive on a done thread shows "Archived · … Undo" ([17f-after-archive](2026-10-14-ux/17f-after-archive.jpg)).
- **Back to app** returns to the last thread. ⌘, opens Settings.
- **One launcher.** ⌘K and the sidebar Search button open the same palette in 124–149 ms, with Stop, Allow/Deny, Switch model, Change effort, Next thread that needs you ([04a-cmdk](2026-10-14-ux/04a-cmdk.jpg)).
- **Thread navigation keys** ⌥⌘↑/↓ and ⌥⌘J exist and work.
- **Setup is two steps** (Connect your agents → Choose your first project) ([05a-first-launch](2026-10-14-ux/05a-first-launch.jpg)).
- **Effort is one click:** the "Medium" half of the model chip opens an effort slider ([14c-click-effort-half](2026-10-14-ux/14c-click-effort-half.jpg)).
- **The side panel survives thread switches.**
- **The sidebar list is one Tab stop** with arrow keys and a visible ring ([21a-row-arrow-focus](2026-10-14-ux/21a-row-arrow-focus.jpg)).
- **Esc in a subagent view returns to the parent;** the subagent view has no composer and one `<main>`.
- **Approval strip clears in 50 ms** after a click.
- Dark mode applies in 159 ms and persists across navigation.

Still true from Oct 13, carried forward below: focus lands on Deny when an approval thread opens (now by design for high-risk approvals, see §1.1); the Work card and the Changes tab disagree (§1.5); panel tabs pile up and the tool never takes focus (§1.4); the "ace" wordmark and the hero sentence on New thread (§2.2); no side panel or Access control at 390 px (§2.9); "Y P W" letter discs on Providers (minor, §2.8).

## 1. Top 10 UX problems, ranked by daily-use pain

### 1.1 Focus lands somewhere different every time a thread opens (major)

Measured `document.activeElement` after opening a thread by click, by ⌥⌘↓ and by Enter on a row: a working or done thread → the composer; a high-risk approval → **Deny**; an ordinary approval → **Allow once**; a question → a radio **with no accessible name**; a thread that has a Browser tab open → the browser's **Address** field. After Stop → the round **Send** button. After Steer, after Snooze, after opening the side panel → `<body>`. On a fresh load of `/`, the app redirects to the top needs-you thread and focus is on Deny before the page has finished painting ([01-home-first-load](2026-10-14-ux/01-home-first-load.jpg)).

Each rule is defensible on its own; together they mean the next keystroke goes somewhere the person can't predict. The one thing Codex and t3code never do is make you look for the caret.

Root cause: `apps/web/src/features/thread/composer/focus-on-open.ts` (`focusOpenRequest`: Deny for `data-approval-deliberate`, else the first option), `features/thread/composer/request-stack.tsx` (re-focuses the card on every controls change), and the panel/tool code that leaves focus on the "New tab" button or moves it into the Address field. Stop and Steer don't restore the composer.

Fix: one rule. Opening a thread, finishing an action (approve, deny, answer, stop, steer, snooze, pin, panel open) always puts focus in the composer unless a modal is open. The strip is reached with one key from the composer (see 1.2). Keep `data-approval-deliberate` as a _default button_ rule (Enter in the strip means Deny), not a focus rule.

### 1.2 You can't answer an approval or a question from the keyboard without hunting (major)

From the composer: pressing `1` types "1" (the question card shows hints 1/2/3, but they only work once focus is inside the card); ⌘⏎ does nothing; the only routes are Shift+Tab three times, or ⌘K → "Allow once". `[` and `]` page between requests but nothing shows it. On approvals the Allow button carries no key at all (`approvalByKey` deliberately leaves high-risk Allow unkeyed) while Deny carries `aria-keyshortcuts="2"`, so a screen reader hears "Deny, 2" and nothing for Allow ([03a-approval-details](2026-10-14-ux/03a-approval-details.jpg)).

Root cause: `components/approval-request.tsx:128` (keys only when `numbered && keyed`), `request-stack.tsx` `onKeyDown` (ignores digits when `typing(event.target)`), and no "go to the strip" key in `lib/keymap.ts`.

Fix: when the composer is **empty**, digits and Enter act on the strip (Enter = the strip's default, which is Deny for high-risk); ↑ or ⌥↑ from the composer moves focus into the strip; show the key on each button as a `Kbd`, and the same key on every surface (strip, ⌘K, Activity while it exists). A non-empty composer keeps digits as text.

### 1.3 The whole app is replaced by "Starting ace…" after it has painted (major; blocker if it reproduces with the real daemon)

Sampling every 100 ms on a direct load of a thread: feed and composer on screen at 605 ms; at 732 ms the entire window is the splash ([21f-bogus-1.2s](2026-10-14-ux/21f-bogus-1.2s.jpg)); the app is back at 1621 ms. The same splash replaced the app in the disconnect test ([19a-disconnected](2026-10-14-ux/19a-disconnected.jpg)). The warm full reload takes 3.3 s to the composer in dev, all of it behind the splash, even though first paint is at 50 ms.

Root cause: `apps/web/src/app/connection-gate.tsx` ~412: `status.kind === "starting"` renders `StartupPending` with no `state.shown` guard, so a `starting` status arriving after `ready` unmounts the app. `behindSplash` has the guard; this branch doesn't.

Fix: once `state.shown` is true, never render the splash again; a daemon that is starting or reconnecting is a one-line banner over the app with the last state kept on screen (priority 2 in AGENTS.md). Verify against the real daemon restart path before closing.

### 1.4 Side-panel tools pile up as tabs and never take focus (major)

Open the panel (⇧⌘B): Summary with a spinner, focus on `<body>`. ⌃` adds a Terminal tab, focus stays on the "New tab" button. ⌃⇧B adds Browser, focus still on "New tab", address bar untouched. ⇧⌘D selects Changes, which first says "Reading changes…" then "Preparing 2 files…". After three shortcuts the 520 px panel holds Summary, Changes, Files, Terminal, Browser and an overflow menu ([14g-tabs-after-three-tools](2026-10-14-ux/14g-tabs-after-three-tools.jpg)). Opening the thread later lands focus in that Browser's Address field (1.1).

Root cause: `features/shell/workspace/*` (each shortcut appends a tab), `features/panels/launcher/tool-grid.tsx` (the launcher stays a tab), no `focus()` on the created tool.

Fix: a shortcut _replaces_ the launcher or re-selects an existing tab of that kind, never adds a second; opening a tool focuses its primary input (terminal, address bar, file search, diff list); the panel opens on the tab the thread last used, not Summary with a spinner. The "+" launcher is a menu, not a tab.

### 1.5 Two answers to "what changed" (major)

On thread-retry-budget the Work card says "Uncommitted +34 −1 · 2 files" and offers Commit & push; the Changes tab, scope Uncommitted, says "No uncommitted changes · The working tree matches HEAD" ([08a-work-card](2026-10-14-ux/08a-work-card.jpg), [08b-after-click-changes](2026-10-14-ux/08b-after-click-changes.jpg)). In fake mode the two read different seeds (`packages/fake-daemon/src/scenarios/card-details.ts` vs `workbench.ts`), which is the point: the client has two owners for the same fact. The card's popover also doesn't trap focus: nine Tabs walk out through an empty `<span>` to "Skip to content" and the Search button.

Fix: one changes query feeds both the card's line and the tab's list, with one scope label shown in both; the card is a dialog that traps focus and closes on Esc back to the composer.

### 1.6 Hover or focus on a sidebar row hides the one thing the row is for (major)

Hovering "Partial refunds double-count tax" removes "Approve" and shows a clock and "⋯" instead; arrowing onto a row does the same ([17c-row-hover](2026-10-14-ux/17c-row-hover.jpg), [21a-row-arrow-focus](2026-10-14-ux/21a-row-arrow-focus.jpg)). The attention level (owner decision: "Needs you" strong, "Failed" strong until seen) disappears at the moment the person looks at it or is about to press Enter.

Root cause: `features/home/thread-row.tsx:90` (`group-hover/row:hidden group-focus-within/row:hidden` on the status slot).

Fix: the status word stays; Snooze and "⋯" appear on the third line's right edge, or only on the "⋯" affordance itself. (The visual proposal raises the same point from the styling side.)

### 1.7 A thread paused by a usage limit is a dead end (major)

thread-limit-ci shows "Paused · Codex usage limit" and the strip "Usage limit reached · Codex · Team resets 6:00 PM, in 1h 28m. Queued messages wait. · Resume at reset" ([26a-limit-thread](2026-10-14-ux/26a-limit-thread.jpg)). The only controls are Copy, Add files and Send. The model chip knows about Personal, Work and CLI accounts and other providers, but the strip doesn't offer "Continue on Personal" or "Switch model", and nothing links to Usage.

Fix: the strip offers the next account on the same provider that has headroom, then "Switch model…" (opens the chip), then "Resume at reset". Keep "Resume at reset" as the quiet default; ace never starts a turn by itself, so each is a button, not an automation.

### 1.8 One interrupted turn is described three ways (major, conflicts with an owner decision)

The held thread shows, in order: "Couldn't stop the agent ×3 · OpenCode had nothing running to stop", "Interrupted by a restart", then the strip "Stopped by a restart · **Continue**" ([14a-interrupted-held](2026-10-14-ux/14a-interrupted-held.jpg)). The owner's decision is "Interrupted by a restart · Resume". Three phrasings (Couldn't stop / Interrupted / Stopped) and two verbs (Continue / Resume) for one event.

Root cause: `features/thread/transcript/turn-end.tsx` (ending === "interrupted" → "Stopped"), the stop strips in `features/thread/composer/stop-strips.tsx` and `queue-strip.tsx` ("Continue"), and the daemon notice text.

Fix: one line in the transcript, "Interrupted by a restart", and the strip "Interrupted by a restart · Resume"; fold the ×3 failed stops into the turn's "Worked for" group.

### 1.9 New thread splits "where" across two places (minor, daily)

The project lives in the hero sentence "What should we work on in **ace** ▾?" in the middle of the page, 330 px above the composer; machine, worktree and branch live in the composer's strip; the composer has Access and Model ([02-new-thread](2026-10-14-ux/02-new-thread.jpg)). A person setting up a thread moves between the two. The "ace" wordmark above the sentence narrates the product (owner rule: nothing narrates the UI to itself; Oct 13 asked for its removal).

Fix: the project chip joins the composer strip ("ace · This Mac · Worktree · origin/main"); the hero becomes the empty space Codex leaves. The sentence can stay as a one-line prompt without the wordmark if the owner wants a greeting.

### 1.10 The "6 need you" row sends people to a page that is being removed (minor now, blocker on the day Activity goes)

`features/home/home-sidebar.tsx:110` links the needs-you row to `/activity`; `g a` and the Activity keymap scope (`activity.*`) still exist. Approvals already live in each thread and ⌥⌘J walks them.

Fix: the row becomes a filter on the list (show only needs-you), and Enter on it opens the first; delete `/activity`, `goActivity` and the `activity.*` keys together.

## 2. Flow-by-flow findings

Severity: **B** blocker, **M** major, **m** minor. "Principle" is what Codex/t3code do, as a rule, not as code.

### 2.1 First launch and signing in a provider

- Two steps, two clicks to Home ([05a-first-launch](2026-10-14-ux/05a-first-launch.jpg), [05b-setup-step-1](2026-10-14-ux/05b-setup-step-1.jpg)). Good.
- **m** Step 1 focuses the `<h1>` "Set up"; the first Tab lands on "Check again", not on the one button most people press ("Continue"). Principle: focus the primary action.
- **m** Step 1 shows "4 of 5 ready", "Update available", "Needs attention", "More agents", "Install" for a provider that isn't installed: five statuses on a screen whose job is "connect one". Principle: on first run, show the installed and signed-in ones and a single "Add another" link.
- **m** "Skip for now" on step 2 lands on a Home that says "Add your first project" with one button, i.e. the step you just skipped. Principle: a skipped step is not shown again immediately.
- Sign in to Cursor opens a dialog with "Open sign-in page" focused, "Waiting for you to finish in your browser", Copy link and Cancel ([11-add-account](2026-10-14-ux/11-add-account.jpg)). Good.

### 2.2 Start a new thread

- Send: 19 ms to the message, 0 blank frames, CLS 0.0035. Good.
- **m** Focus passes Message → body → H1 → Message in ~100 ms. Harmless now; it will show as a flicker of the focus ring once rows get one.
- **m** 1.9: project picker in the hero, not in the composer. [02b-project-picker](2026-10-14-ux/02b-project-picker.jpg) is otherwise right (search, Add project).
- **m** Model picker ([02c-model-picker](2026-10-14-ux/02c-model-picker.jpg)): an eight-icon provider rail with no labels until hover, a refresh icon, an empty lower half. ⌘1–3 pick models while the picker is open; nothing says so until you open it. Effort is a separate popover on the "Medium" half; nothing signals that the chip has two halves. Principle: one popover, model list on the left, effort for the chosen model on the right.
- **m** The Access menu stays open if a click lands on the composer while it is open, and typing then changes the setting by typeahead (observed once: "Add a retry…" selected Read-only). Esc closes it correctly. Principle: a click outside a menu closes it _and_ goes through.
- The new thread's row appears at y = 628, under six needs-you rows, because the list sorts by attention. Visible, but the person has to find it. **m**: flash the new row or keep the created thread pinned to the top for the first minute.

### 2.3 Follow a working agent

- "Working for 11m 2s · 2 subagents working · 1 background command" is the inline end line; finished turns fold into "Worked for …". Matches the owner's rules ([06a-working-thread](2026-10-14-ux/06a-working-thread.jpg)).
- Stick-to-bottom and "Jump to live" work after scrolling up ([06h-scrolled-up-streaming](2026-10-14-ux/06h-scrolled-up-streaming.jpg)).
- Thread switch: 67–117 ms to content, one frame with an empty feed. Acceptable; the one empty frame is a visible blink on a 120 Hz display. **m**: keep the previous feed until the next one has painted.
- **M** Long thread (120 exchanges): 608 ms to content; scrolling up through history produces 21 of 92 frames over 33 ms, worst 250 ms. Principle: history pages are measured in and never block the frame.
- **M** 1.4: panels.
- **m** Expanding "2 subagents" and clicking one opens `/agents/…` with focus on the `<h1>`; Esc returns. Fine. The subagent page repeats "Working for 6m 34s" twice (transcript and header card) ([22f-subagent-view](2026-10-14-ux/22f-subagent-view.jpg)).
- **m** The turn rail: `turn-rail.tsx` shows it from six turns. On the 120-exchange thread the probe did not find a rail element in the left gutter; the "Turns" listbox (⌥⌘G) opened with focus inside it. Verify the rail renders on long threads; it is the owner's chosen way to navigate turns.

### 2.4 Answer an approval or a question

- Mouse: Allow once → strip gone in 50 ms. The transcript line "Waiting for your approval" disappears at the same time, and nothing says "Approved" until the daemon answers (1.5 s in fake mode). **m**: show "Approved by you" in the transcript at once, optimistic, and replace it if the daemon refuses.
- **M** 1.1 and 1.2.
- **M** Question card ([03e-question](2026-10-14-ux/03e-question.jpg)): the radios have empty accessible names (`span[role=radio] ""`); a screen reader hears "radio, radio, radio". The card has 13 focusable controls (4 radios, 4 hidden inputs, a text field, prev/next, Skip, Continue). The question text is only in the strip, not in the transcript, so after answering there is no record of what was asked until the daemon writes one.
- **m** Approval Details repeats the command under the title ([03a-approval-details](2026-10-14-ux/03a-approval-details.jpg)); keep the one-line reason only.

### 2.5 Steer, queue, stop, resume

- Typing while working turns the button into "Queue message"; Enter queues; the queue strip is compact with Edit, Steer and × ([07c-after-enter-1.3s](2026-10-14-ux/07c-after-enter-1.3s.jpg)). Good.
- Esc guard works. Stop by button stops at once with "Stopped · 1 background command still running · Stop it · 1 queued" ([10e-after-stop-with-queue](2026-10-14-ux/10e-after-stop-with-queue.jpg)). Good feedback.
- **M** Focus after Stop → the Send button; after Steer → body (1.1).
- **M** 1.8: interrupted-turn copy.
- **m** General settings explain "Queue waits for the turn to finish; Steer adds it to the running turn. ⌘↵ does the other." The keyboard page lists ⌘↵ as "Send". Pick one description.

### 2.6 Find, switch, archive, pin, snooze

- ⌘K: 124–149 ms, one launcher, thread results plus commands, focus to the composer after picking. Good.
- ⌥⌘↑/↓ and ⌥⌘J work.
- **M** 1.6: hover hides the status word.
- **m** End/Home in the list drop focus to `<body>`. Enter on a row moves focus out of the list (to the composer, or to the Address field), so arrow-browsing threads needs Tab back each time; ⌥⌘↓ is the workaround.
- **m** `p` pins silently (the row moves to the top with "Pinned" in its label; no toast); Unpin shows "Unpinned · … Undo". Make both symmetrical or both silent.
- **m** Snooze ("1 hour / Tomorrow / Next Monday") shows a toast and keeps the thread open and in the list; focus to `<body>` ([21c-snooze-submenu](2026-10-14-ux/21c-snooze-submenu.jpg)).
- **m** Archive on a done thread takes more than 500 ms to act, then lands on the _top needs-you thread_ (a high-risk approval with focus on Deny) rather than the next row or Home. Principle: after archiving, go to the neighbouring row.
- **m** An unknown `/t/:id` shows nothing for ~2.3 s after boot, then "This thread doesn't exist · Back to Home" ([16a-bogus-thread](2026-10-14-ux/16a-bogus-thread.jpg)). Say so as soon as the index has loaded.

### 2.7 Review changes, commit or PR

- The Work card is compact and in the right header slot ([06g-work-card](2026-10-14-ux/06g-work-card.jpg)): machine, open in editor, branch, Push, Uncommitted, PR, "2 commits not pushed". Good shape.
- **M** 1.5: card vs tab disagree; the card doesn't trap focus.
- **m** "Add project script" sits in the thread's Work card between "Open in editor" and the branch; it is project setup, not thread work.
- **m** Changes tab: scope menu "Uncommitted / Last turn · Turn 1 / This thread" is the first control; the list says "Reading changes…" then "Preparing 2 files…" on open. Principle: the diff list is kept warm for the open thread, so the tab opens full.
- Git actions: "Commit & push" and "More git actions (Commit, push, create PR)" exist on both the card and the tab header. Good.

### 2.8 Settings

- Dark in 159 ms, persists. Back to app returns to the thread. ⌘, works.
- **m** Appearance's text contains "Ready." eleven times (theme previews' status text), which a screen reader reads as "Ready. Ready. System Ready. Light …" ([11-settings-appearance](2026-10-14-ux/11-settings-appearance.jpg)).
- **m** Providers: "Y P W" letter discs per provider (carried from Oct 13; [11-settings-providers](2026-10-14-ux/11-settings-providers.jpg)).
- **m** Keyboard page is one long table with 50+ rows including an Activity section (2.10).
- Permissions: General → Access (Read-only / Ask / Auto review / Full access) "Follows your last choice." Matches the owner's provider-native decision. Good.

### 2.9 Narrow window, mobile width, keyboard-only, screen reader

- 390 px ([23b-390-thread](2026-10-14-ux/23b-390-thread.jpg)): Allow once 99×44, Deny 64×44 (fixed since Oct 13). **M** The Access control is hidden (0×0), there is no Right panel button so Changes is unreachable, "Details" is 58×18. The thread list is reached by "Back to threads", which focuses Search.
- 768 px: sidebar hidden by default, strip buttons 26 px tall (fine for a pointer, not for touch).
- Keyboard: from the top of the document the composer is 16 Tab stops away; the sidebar list is one stop. Good. Row ring is visible with arrows.
- Screen reader: one `<main>`, one `<h1>`, landmarks named ("Threads", "Transcript", "Waiting for you"). **M** Unnamed radios in the question card (2.4). **m** Live regions: a `polite` span with no text and two `status` elements ("Working", "2 working") that update every second, which chatty readers will announce.

### 2.10 Things that narrate or duplicate (owner rule: every element earns its place)

- "ace" wordmark on New thread (1.9).
- "Starting ace…" as the only thing on screen for 3 s on load, and again after the app has painted (1.3).
- Three phrasings for one interrupted turn (1.8).
- "Working for …" shown twice on a subagent page (2.3).
- Two explanations of ⌘↵ (2.5).
- "Ready." ×11 on Appearance (2.8).
- `/activity`, `g a`, and seven `activity.*` keys for a page that is going away (1.10).

## 3. Interaction principles for ace

Use these in reviews. Each has a measurable test.

1. **Focus lands where the next keystroke goes.** After any action, `document.activeElement` is the composer, unless a modal is open or the person is mid-request. Never `<body>`, never a button that just acted.
2. **Every action answers within 100 ms.** Optimistic state in the transcript ("Approved by you", "Queued", "Stopped"), corrected if the daemon disagrees.
3. **The screen never goes blank once it has painted.** No splash, no empty feed frame, no skeleton over a thread that was already on screen. Reconnects are a banner.
4. **One fact, one owner.** Status, changes, subagent counts and the interrupted state each come from one query and are shown once per surface.
5. **A destructive default is a button, not a focus target.** High-risk approvals make Deny the strip's default; the caret stays in the composer.
6. **Shortcuts replace, they don't add.** Opening a tool selects its tab (or creates the only one) and focuses its input.
7. **Hover and focus add, they never hide.** Row actions appear beside the status word, not instead of it.
8. **State on screen is reachable in one key.** Anything the strip shows can be answered with a digit or Enter from an empty composer.
9. **Nothing starts, stops or moves by itself.** Resume, Continue on another account and Jump to live are buttons; ace never presses them.
10. **No copy about the product.** No wordmark, no "Starting ace…", no sentence that describes a control the person is looking at.
11. **A dead end always has a door.** A paused, failed or interrupted thread offers the next step in the strip, with the quiet option last.
12. **The same key means the same thing everywhere.** One keymap entry per intent; the sheet, the menus and the buttons all read from it.

## 4. Keyboard map review

Source: `apps/web/src/lib/keymap.ts`, Settings › Keyboard, menus and `aria-keyshortcuts` in the DOM.

What is there and right: ⌘K, ⌘N/⌥⌘N, ⇧⌘O, ⌘, , ⌘[ ⌘], ⌘\, ⇧⌘B, ⌥⌘↑/↓, ⌥⌘J, ⌥⌘G, ⇧⌥⌘↑/↓, ⌥⌘R, ⌥⌘P, ⇧⌘A, ⌥⌘O, ⇧⌘D, ⌃`, ⌃⇧B, ⌘P, ⌘F (scoped), F6, `g h`, and the list keys `p`, `x`, space.

Missing or conflicting:

| Issue                                                                                           | Where                                       | Proposal                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No key to focus the strip, and digits don't work from the composer                              | `request-stack.tsx`, `approval-request.tsx` | ↑ (empty composer) or ⌥↑ moves to the strip; `1–9` and ⏎ act on it from an empty composer; keys shown as `Kbd` on every button |
| No key to focus the composer from anywhere                                                      | —                                           | Esc from a panel/tool, or ⌘L (Codex users expect a "go to input" key)                                                          |
| Stop is Esc×2 only; Codex/t3code users also reach for ⌃C                                        | `composer.tsx`                              | add ⌃C as `also` on stop, same two-step guard                                                                                  |
| ⌃⇧A is "Summary" in the keymap and "Open agent tree" in the thread menu                         | `keymap.ts:59`, `thread-menu`               | one label                                                                                                                      |
| ⌘↵ is "Send" on the Keyboard page and "the other of Queue/Steer" in General                     | `keymap.ts:92`, `general-page.tsx`          | one description, on both pages                                                                                                 |
| ⌘F is "Search this thread" and "Find in a terminal or log"                                      | `keymap.ts:68,89`                           | fine as scoped; show the scope on the sheet                                                                                    |
| ⌘J is an alias for Terminal; t3code users expect ⌘J to toggle the panel                         | `keymap.ts:61`                              | keep, document                                                                                                                 |
| ⌘1–3 pick a model only while the picker is open; t3code users may expect ⌘1–9 to switch threads | model picker                                | document; consider ⌃1–9 for the first nine rows                                                                                |
| End/Home in the thread list drop focus                                                          | `features/home` list                        | handle End/Home                                                                                                                |
| `g a` and `activity.*` (j k ⏎ a d e u)                                                          | `keymap.ts:94–104`                          | delete with Activity                                                                                                           |
| ⌘/ shortcut sheet: the probe found no dialog within 600 ms                                      | `shell/shortcut-host.tsx` (lazy import)     | verify it opens; preload on first ⌘ keydown                                                                                    |
| `[` `]` page between requests, undocumented                                                     | `request-stack.tsx`                         | show on the pager                                                                                                              |
| ↑ in an empty composer to edit the last message (chat convention)                               | —                                           | optional; conflicts with the strip proposal, pick one                                                                          |

## 5. Prioritised plan: small PRs

Ordered by daily pain over effort. Each is one PR with one acceptance test.

| #   | PR                                                                                                                                                           | Files                                                                      | Win                                    | Acceptance                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **Focus rule:** composer after open, approve, deny, answer, stop, steer, snooze, pin, panel open                                                             | `focus-on-open.ts`, `request-stack.tsx`, `composer.tsx`, `workspace/*`     | every keyboard user, every thread open | `activeElement` is the composer in all nine cases above; Deny is the strip default, not focused           |
| 2   | **Strip from the keyboard:** digits/⏎ from an empty composer, ↑ into the strip, keys shown on buttons, same keys in ⌘K                                       | `approval-request.tsx`, `request-stack.tsx`, `keymap.ts`                   | approvals in one keystroke             | `1` from an empty composer allows; `2` denies; ⏎ = default; a non-empty composer keeps digits as text     |
| 3   | **Never re-splash:** guard the `starting` branch on `state.shown`; banner for restarts                                                                       | `app/connection-gate.tsx`                                                  | no blank window on reconnect/restart   | after first paint, the splash never mounts; a daemon restart shows a banner with the thread still visible |
| 4   | **Tools replace, and take focus**                                                                                                                            | `workspace/tab-item.tsx`, `tool-grid.tsx`, terminal/browser/changes mounts | panel stops piling up                  | after ⌃` ⌃⇧B ⇧⌘D the panel has ≤3 tabs and the terminal/address/diff has focus                            |
| 5   | **One changes query** for card and tab; card traps focus                                                                                                     | `work-card`, `changes` panel                                               | trust in "what changed"                | card line equals tab total for every scope; Tab cycles inside the card                                    |
| 6   | **Row status stays on hover/focus**                                                                                                                          | `thread-row.tsx:82–90`                                                     | sidebar does its job                   | status word visible in hover and focus states; actions on the third line                                  |
| 7   | **Usage-limit strip offers the next account and Switch model**                                                                                               | limit strip component, model picker API                                    | no dead end at a limit                 | strip shows "Continue on <account>" when one has headroom, then "Switch model…", then "Resume at reset"   |
| 8   | **One interrupted copy:** "Interrupted by a restart · Resume"                                                                                                | `turn-end.tsx`, `stop-strips.tsx`, `queue-strip.tsx`                       | matches the owner decision             | one transcript line, one strip, verb "Resume"                                                             |
| 9   | **Project chip into the composer strip; remove the wordmark**                                                                                                | `new-thread-page.tsx`, composer strip                                      | one place to set up a thread           | no `<h1>`/wordmark on /new; project is a chip beside machine/worktree/branch                              |
| 10  | **Retire Activity:** needs-you row filters the list; delete `/activity`, `g a`, `activity.*`                                                                 | `home-sidebar.tsx:110`, `keymap.ts`, `features/activity`                   | removes a parallel inbox               | ⌘K has no Activity entry; the row filters                                                                 |
| 11  | **Optimistic "Approved/Denied/Answered by you"** row in the transcript                                                                                       | `interaction-card.tsx`, transcript                                         | no 1.5 s silence                       | row appears ≤100 ms after click                                                                           |
| 12  | **Question card a11y:** named radios, fewer stops, question recorded in the transcript                                                                       | `question-record.tsx`, `interaction-card.tsx`                              | screen readers can answer              | each radio has a name; ≤7 stops; the question text is in the feed after answering                         |
| 13  | **Long-thread scroll:** page in history without blocking frames                                                                                              | `transcript/feed.tsx`, long-thread data APIs                               | smooth history                         | ≤2 frames over 33 ms in 20 wheel events on the 120-exchange thread                                        |
| 14  | **390 px:** Access chip reachable, side panel/Changes reachable, Details ≥ 44 px                                                                             | composer, header                                                           | phone width usable                     | all three present and ≥ 44 px tall                                                                        |
| 15  | **Small polish:** End/Home in the list; pin toast symmetry; archive lands on the neighbour; unknown thread says so at once; "Ready." ×11; menu click-through | various                                                                    | fewer small surprises                  | each as listed                                                                                            |

## 6. Questions for the owner (conflicts with settled decisions)

1. **"Interrupted by a restart · Resume"** vs the current "Stopped by a restart · Continue": is "Resume" the final word? The queue strip also uses "Resume the queue before steering."
2. **Deny on focus for high-risk approvals** is deliberate code. Principle 5 keeps Deny as the default but leaves focus in the composer. Acceptable, or is focus-on-Deny the intended guard?
3. **Project in the composer strip** means the strip above the composer holds five chips on /new (project, machine, worktree, branch, and, once a thread exists, the request/queue strip takes the slot). Is that within "exactly one strip above it"?
4. **Needs-you row as a filter** replaces the Activity page's "answer everything in one place". ⌥⌘J gives the same walk. Confirm that is enough before Activity is deleted.
