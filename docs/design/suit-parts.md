# Suit parts

The styling contract for Suits ([ADR 0150](../adr/0150-suits.md), "Full customisation"). Every
name below is a `data-part` the app renders; `suit.css` selects these, plus `data-state`,
`data-variant` and `data-scheme`, and nothing else. The list lives in `@ace/protocol/suit-parts`
(`suitParts`, version `suitPartsVersion`); `apps/web/src/features/suits/suit-parts-drift.test.tsx`
fails when a listed part stops being drawn.

Parts are public API. Renaming or removing one needs an alias for one release and a note under
"Changes" at the end of this page.

## Selecting

```css
[data-part="thread-row"][data-state="active"] { … }
[data-part="button"][data-variant="primary"]:hover { … }
[data-scheme="dark"] [data-part="composer"] { … }
```

- `data-state` holds one value from `suitPartStates`: `active`, `selected`, `open`, `closed`,
  `disabled`, `checked`, `hover`, `working`, `waiting`, `done`, `failed`, `unread`. A part only
  carries the states listed for it below; with none, the attribute is absent. Use `:hover` and
  `:focus-visible` for pointer and focus.
- `data-variant` is a free word per part, listed below.
- Class names, element names, ids and DOM depth are not part of the contract and are refused.

## Protected parts

`working-line`, `approval-strip`, `question-card` and `status-icon` show the state of an agent
(`protectedSuitParts`). A Suit may frame them (spacing, radius, font, border) but ace's guard
layer keeps them visible, unanimated and in ace's colours whatever `suit.css` says.

## Window and regions

| Part             | What and where                                                                              | States                                         | Variants          |
| ---------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------- |
| `app`            | The window's outer frame, behind the sidebar and the canvas. A region.                      |                                                |                   |
| `rail`           | The narrow column of place glyphs at the sidebar's left. A region.                          |                                                |                   |
| `rail-item`      | One place in the rail (Threads, Chats, Settings, the profile).                              | `active`                                       |                   |
| `sidebar`        | The panel beside the rail: the thread list, Settings' pages, Code review's lists. A region. |                                                |                   |
| `sidebar-header` | The sidebar panel's title row (its title and search).                                       |                                                |                   |
| `sidebar-footer` | An empty band along the sidebar panel's bottom edge, for decoration.                        |                                                |                   |
| `sidebar-tabs`   | The Inbox, Snoozed and Settled pill at the thread list's foot.                              |                                                |                   |
| `thread-list`    | The thread list's scrolling area.                                                           |                                                |                   |
| `thread-row`     | One thread in the list, the filled row itself.                                              | `active` (open), `selected` (picked), `unread` |                   |
| `thread-title`   | A thread row's title text.                                                                  |                                                |                   |
| `thread-meta`    | A thread row's trailing status, PR or line counts (a task row's top line).                  |                                                |                   |
| `project-header` | The row under the sidebar title with the project filter and New thread.                     |                                                |                   |
| `header`         | The top bar over the main column. A region.                                                 |                                                |                   |
| `header-title`   | The top bar's title (the thread's name).                                                    |                                                |                   |
| `main`           | The main column's content area, under the header.                                           |                                                |                   |
| `transcript`     | A thread's scrolling transcript. A region.                                                  |                                                |                   |
| `right-panel`    | The thread's side or bottom panel (Changes, Files, Terminal, Browser).                      |                                                | `right`, `bottom` |
| `panel-header`   | The side or bottom panel's tab strip row.                                                   |                                                |                   |

## Transcript

| Part            | What and where                                                                                                      | States                                        | Variants        |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------- |
| `message-user`  | The person's message bubble.                                                                                        |                                               |                 |
| `message-agent` | An agent's answer, the whole prose block.                                                                           |                                               |                 |
| `message-meta`  | The time and copy actions under a message.                                                                          |                                               |                 |
| `turn-divider`  | A line across the transcript where the conversation changes hands: a handoff, a fork's start, "Interrupted by you". |                                               | `interrupted`   |
| `tool-row`      | One step in the work log ("Ran …", "Edited …").                                                                     | `working`, `failed`, `open`, `closed`, `done` |                 |
| `tool-output`   | A step's output, opened under it.                                                                                   |                                               | `raw`, `json`   |
| `code-block`    | A fenced code block in an answer, with its copy button.                                                             |                                               |                 |
| `inline-code`   | Inline code in an answer.                                                                                           |                                               |                 |
| `diff`          | A file's diff, opened under an edit step.                                                                           |                                               |                 |
| `link`          | A link in an answer, or a web link anywhere.                                                                        |                                               |                 |
| `attachment`    | An attached image tile or file chip.                                                                                |                                               | `image`, `file` |

## Agent state (protected)

| Part             | What and where                                                                                 | States                                 | Variants                                     |
| ---------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| `working-line`   | "Working for 1m 14s" under the running turn.                                                   | `working`, `waiting`                   |                                              |
| `approval-strip` | A request waiting on the person in the composer's strip (an approval, or another kind of ask). | `waiting`                              | the request's kind: `approval`, `browser`, … |
| `question-card`  | An agent's question, open in the strip or answered in the transcript.                          | `waiting`, `done`                      | `question`                                   |
| `status-icon`    | A status glyph: thread rows, agent lines, the hover card.                                      | `working`, `waiting`, `done`, `failed` |                                              |

## Composer

| Part               | What and where                                   | States             | Variants                                     |
| ------------------ | ------------------------------------------------ | ------------------ | -------------------------------------------- |
| `composer`         | The composer's surface. A region.                |                    |                                              |
| `composer-input`   | The message field's area.                        |                    |                                              |
| `composer-toolbar` | The row of controls under the field.             |                    |                                              |
| `composer-send`    | The primary button: Send, Steer, Queue, or Stop. | `disabled`         | `send`, `steer`, `queue`, `stop`, `stopping` |
| `model-picker`     | The model chip that opens the model list.        | `open`, `disabled` |                                              |

## Controls

| Part          | What and where                                | States                         | Variants                                  |
| ------------- | --------------------------------------------- | ------------------------------ | ----------------------------------------- |
| `button`      | A labelled button.                            | `disabled`                     | `primary`, `secondary`, `ghost`, `danger` |
| `icon-button` | A glyph-only button.                          | `active` (pressed), `disabled` |                                           |
| `input`       | A text field.                                 | `disabled`                     | `multiline`, `search`, `inline`           |
| `select`      | A select's trigger.                           | `disabled`                     |                                           |
| `checkbox`    | A checkbox.                                   | `checked`, `disabled`          |                                           |
| `switch`      | A switch.                                     | `checked`, `disabled`          |                                           |
| `slider`      | A slider.                                     | `disabled`                     |                                           |
| `tabs`        | A tab strip (the panel's tabs, in-page tabs). |                                |                                           |
| `tab`         | One tab.                                      | `selected`                     |                                           |
| `badge`       | A small count or label pill.                  |                                |                                           |
| `kbd`         | A keyboard shortcut's keys.                   |                                |                                           |

## Floating layers

| Part              | What and where                                              | States                | Variants                                                      |
| ----------------- | ----------------------------------------------------------- | --------------------- | ------------------------------------------------------------- |
| `menu`            | A menu, a select's list or a right-click menu.              | `open`                | `context`, `select`                                           |
| `menu-item`       | One item in a menu, a select's list or the command palette. | `disabled`, `checked` | `danger`, `submenu`, `radio`, `checkbox`, `option`, `command` |
| `popover`         | A popover (the model list, a date picker).                  | `open`                |                                                               |
| `dialog`          | A dialog or a sheet.                                        | `open`                | `sheet`                                                       |
| `tooltip`         | A tooltip.                                                  |                       |                                                               |
| `toast`           | A notification toast.                                       |                       | `plain`, `error`, `warning`, `success`, `info`, `loading`     |
| `command-palette` | The command palette, search and the other ⌘K-style sheets.  | `open`                |                                                               |

## Pages and panels

| Part               | What and where                                                                                                                                                                       | States                         | Variants           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------ |
| `settings-nav`     | Settings' list of pages in the sidebar.                                                                                                                                              |                                |                    |
| `settings-section` | A titled group of settings on a page.                                                                                                                                                |                                |                    |
| `settings-row`     | One setting: its title, description and control.                                                                                                                                     |                                |                    |
| `nav-item`         | A row in a sidebar list other than threads (Settings' pages, Skills, Automations).                                                                                                   | `active` (Settings' open page) |                    |
| `terminal`         | A terminal's screen.                                                                                                                                                                 |                                |                    |
| `file-tree`        | The Changes or Files tree.                                                                                                                                                           |                                | `changes`, `files` |
| `browser-panel`    | The in-app browser's tab, with its toolbar and page.                                                                                                                                 |                                |                    |
| `empty-state`      | An empty view's message ("No threads yet").                                                                                                                                          |                                | `inline`           |
| `scrollbar`        | A scrolling page body with no part of its own (Settings, pages); style its bar with `scrollbar-color` or `::-webkit-scrollbar`. Regions with their own part style theirs through it. |                                |                    |
| `divider`          | A separator line, in menus and pages.                                                                                                                                                |                                |                    |

## Settings, account and connection pages

`apps/web/src/features/settings/settings-parts-drift.test.tsx` renders these pages with fake data
and fails when one drops its `data-page`, `data-variant` or a part listed for it.

| `data-page` | `data-variant` on its `page`                                                                                                                                                                                                         | Where                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `settings`  | the page's path word: `profile`, `agents`, `providers`, `prompts`, `source-control`, `browser`, `computer-use`, `spade`, `simulators`, `storage`, `advanced`, `general`, `appearance`, `notifications`, `keyboard`, `remote` (Fleet) | Every Settings page and its sub-pages (a provider's page is `providers`, a Fleet machine `remote`). |
| `setup`     | `providers`, `project` (the step on screen)                                                                                                                                                                                          | First-run setup.                                                                                    |
| `connect`   | `connect`, `account-machine`, `handoff`, `boot-failure`, `desktop-failure`, `startup`                                                                                                                                                | The screens before the app: connecting, hand-off, failures, the startup mark.                       |
| `sign-in`   | `landing` (the page a web sign-in returns to); `provider` on a provider's sign-in `dialog`                                                                                                                                           | Signing in.                                                                                         |

On these pages:

| Part           | What and where                                                                                                                         | States                                                          | Variants                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page-header`  | The title row (Settings, setup); the app mark on a connect card.                                                                       |                                                                 |                                                                                                                                                                 |
| `page-title`   | The page's heading.                                                                                                                    |                                                                 |                                                                                                                                                                 |
| `page-toolbar` | A Settings page's controls right of the title; setup's footer; startup's buttons.                                                      |                                                                 |                                                                                                                                                                 |
| `page-body`    | The content under the title.                                                                                                           |                                                                 |                                                                                                                                                                 |
| `page-section` | A section that isn't a settings group: setup's "More agents", startup's failure, a devices panel section.                              | `failed` (startup)                                              | `not-installed`, `failure`                                                                                                                                      |
| `card`         | A settings group's rounded surface; a theme or mode choice and its preview; an accent swatch; the connect card; a running device tile. | `checked` (picker, preview, accent), `open`, `working` (device) | `settings-group`, `picker`, `preview`, `accent`, `connect`, `device`                                                                                            |
| `list`         | A list of rows or choices.                                                                                                             |                                                                 | `mode`, `theme`, `accent`, `providers`, `sign-in-choices`, `checks`, `repairs`, `tools`, `models`, `recent-devices`, `running-devices`, `device-kinds`          |
| `list-row`     | One row: a provider, an account, a machine or device, a connected app, a check, a sign-in choice, an add row.                          | `working`, `failed`, `waiting`, `disabled`, `done`, `open`      | `provider`, `account`, `action` (Add …), `grant`, `account-machine`, `device`, `check`, `repair`, `tool`, `sign-in-choice`, `provider-share`, Fleet's row kinds |
| `list-group`   | A disclosure of rows (Settings' folded groups, a device kind, a model picker provider group).                                          | `open`, `closed`, `working`                                     | the device kind or provider                                                                                                                                     |
| `settings-row` | Also carries a state and variant where one applies: a Suit in Appearance.                                                              | `selected` (in use), `failed` (needs fixes)                     | `suit`                                                                                                                                                          |
| `stat`         | A headline number on Profile.                                                                                                          | `working` (loading)                                             | `highlight`, `insight`                                                                                                                                          |
| `chart`        | Profile's activity grid; the Fleet map.                                                                                                |                                                                 | `activity`, `fleet-map`                                                                                                                                         |
| `progress`     | A usage window's bar, a storage bar, an install or setup bar, setup's step dots.                                                       | `working` (no share yet)                                        | `ok`, `low`, `out` (usage windows), `storage`, `install`, `steps`                                                                                               |
| `avatar`       | The person's picture or initials, an account badge, a row's leading tile.                                                              |                                                                 | `picture`, `initials`, `account`, `tile`, `tile-large`                                                                                                          |
| `label-chip`   | A small word pill: an account's Default, a device's Live.                                                                              |                                                                 | `default`, `live`                                                                                                                                               |
| `search-field` | A search field (shared), the sign-in service search, the model search.                                                                 |                                                                 |                                                                                                                                                                 |
| `filter-bar`   | The devices panel's search and platform filter.                                                                                        |                                                                 |                                                                                                                                                                 |
| `menu-item`    | A model in the model picker (`option`), its Legacy models row (`submenu`).                                                             | `checked`, `disabled`, `open`, `closed`                         | `option`, `submenu`                                                                                                                                             |
| `tabs` / `tab` | The model picker's rail of sources.                                                                                                    | `selected`, `disabled` (tab)                                    | `model-sources` (tabs)                                                                                                                                          |

## Side panel

The side panel (and the bottom panel) is the `right-panel` region: it reads
`--suit-right-panel-background`, `-border`, `-shadow` and `-backdrop-filter`, lets
`reveal["right-panel"]` of the app scene through (solid by default), and runs `scenes["right-panel"]`
behind its tabs. Every tab carries its kind as `data-variant` on `panel-tab` and `panel-body`:
`changes`, `files`, `terminal`, `browser`, `preview`, `port`, `logs`, `work`, `devices`,
`new-tab`, `pull-request`, and any tool a later version adds.

| Part            | What and where                                                                                                                            | States                                                           | Variants                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `panel-tab`     | One tab in the panel's strip, around its `tab` button and close.                                                                          | `selected`                                                       | the tab's kind                                                                                 |
| `panel-body`    | A tab's content area, under the strip.                                                                                                    | `active` (shown)                                                 | the tab's kind                                                                                 |
| `panel-toolbar` | A tab's own toolbar: Changes', Files', the browser's and its device bar, Logs', and the strip's actions for the shown tab.                |                                                                  | `changes`, `files`, `browser`, `device`, `logs`, `<kind>-actions`                              |
| `terminal-tab`  | A terminal's tab around its screen: the offline line, the `terminal`, Find and the exit line.                                             | `done` (the shell exited)                                        |                                                                                                |
| `list`          | A list in a tab: the agent tree, the launcher's tools and suggestions, logs, dev servers, downloads, the console, deleted files.          |                                                                  | `agents`, `tools`, `suggested`, `logs`, `dev-servers`, `downloads`, `console`, `deleted`       |
| `list-row`      | One row: a file tree's file or folder, an agent, a changed file, a log line, a dev server, a download, a console message, a deleted file. | `selected` (file trees), `working`, `done`, `failed` (downloads) | `file`, `folder`, `agent`, `info`, `warn`, `error`, `dev-server`, `download`, `log`, `deleted` |
| `card`          | A tool or a suggested site in the launcher.                                                                                               |                                                                  | the tool's kind; `site`, `port`                                                                |
| `diff-file`     | One file's diff in Changes, with its sticky header.                                                                                       | `open`, `closed`                                                 | the file's status: `modified`, `added`, `deleted`, `renamed`                                   |
| `diff-line`     | One line of a diff drawn as text (the GPU renderer draws on a canvas, like the terminal).                                                 |                                                                  | `add`, `del`, `context`; `empty` for a split side with no line                                 |

`file-tree` (`changes`, `files`) and `browser-panel` are listed under "Pages and panels".

## Terminal

The terminal draws on a canvas, so `suit.css` styles its frame (`terminal`, `terminal-tab`) but
not its text. `suit.json`'s `terminal` sets the rest:

- `light` / `dark`: `background`, `foreground`, `cursor`, `cursorAccent`, `selection` (8-digit
  hex for alpha) and `ansi` (the 16 names, `black` … `brightWhite`). Unset ones are derived from
  the Suit's palette. ANSI colours are lifted until they read at 3:1 on the background and the
  foreground at 4.5:1, as for a built-in theme. A foreground under 4.5:1 on its background is a
  `contrast` problem at `terminal.<scheme>.foreground` (or `.background`).
- `fontFamily`: a bundled font's `family` from `fonts` (its file is loaded before the grid is
  measured) or a system stack. `fontSize` (9–24), `lineHeight` (1–2, times the size),
  `letterSpacing` (px), `cursorStyle` (`block`, `bar`, `underline`), `cursorBlink`.
- `reveal` (0–1): how much of the panel's background or scene shows behind the text, held under
  what keeps the text readable.

A new Suit restyles open terminals in place; their sessions and scrollback stay.

## Changes

- Version 1, 2026-11-14: `nav-item` added.
- Version 1, 2026-11-14: side panel parts (`panel-tab`, `panel-body`, `panel-toolbar`,
  `terminal-tab`) and their rows, lists, cards, diff files and diff lines are drawn.
