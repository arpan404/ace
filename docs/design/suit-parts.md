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

## Full pages

Every full page is built from these parts, so a Suit that styles them dresses every page. The
page's canvas is `page`, with `data-page` naming which page it is; the window's `app` part
carries the same `data-page`, so `[data-page="usage"] [data-part="sidebar"]` works too. A thread's
canvas is a `page` as well (`thread` or `chat`).

| Part            | What and where                                                                                                 | States                                                                                                        | Variants                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `page`          | A routed screen's canvas, under the top bar. A region: reads `--suit-page-*`, `reveal.page` and `scenes.page`. |                                                                                                               |                                                             |
| `page-header`   | The block at a page's top with its title, lede and actions.                                                    |                                                                                                               |                                                             |
| `page-title`    | A page's title text.                                                                                           |                                                                                                               |                                                             |
| `page-toolbar`  | A row of a page's actions or view switches.                                                                    |                                                                                                               |                                                             |
| `page-body`     | A page's main content column.                                                                                  |                                                                                                               |                                                             |
| `page-section`  | A titled group within a page.                                                                                  |                                                                                                               |                                                             |
| `list`          | A list of rows on a page.                                                                                      |                                                                                                               |                                                             |
| `list-group`    | A labelled group of rows in a list (a week in History, a source in Skills).                                    |                                                                                                               |                                                             |
| `list-row`      | One row in a list.                                                                                             | `selected`, `active`, `open`, `checked`, `disabled`, `unread`; a run's `waiting`, `working`, `done`, `failed` | a run's status, an activity's kind, `file`/`folder`         |
| `card`          | A boxed item on a page.                                                                                        |                                                                                                               |                                                             |
| `table`         | A table.                                                                                                       |                                                                                                               |                                                             |
| `table-row`     | One row of a table.                                                                                            | `selected`                                                                                                    |                                                             |
| `stat`          | A number tile (a total, a count).                                                                              |                                                                                                               |                                                             |
| `filter-bar`    | A page's filters row.                                                                                          |                                                                                                               |                                                             |
| `search-field`  | A page's or a sheet's search field: the search and command sheets' top row, a folder search.                   |                                                                                                               |                                                             |
| `avatar`        | A bot's or Spade's face.                                                                                       | `working`, `waiting`, `done`                                                                                  | `spade`, `character`, `picture`                             |
| `label-chip`    | A tag or label pill on a row.                                                                                  |                                                                                                               |                                                             |
| `progress`      | A progress bar.                                                                                                |                                                                                                               |                                                             |
| `chart`         | A chart or bar graph (Usage).                                                                                  |                                                                                                               |                                                             |
| `spade-message` | One message in a Spade, bot or group conversation.                                                             | `working` (being written), `failed`                                                                           | who wrote it: `user`, `spade`, `bot`, `other` (another bot) |
| `chat-row`      | One chat in the Chats panel.                                                                                   | `active` (open), `unread`                                                                                     |                                                             |

### Pages

`data-page` takes one value from `suitPages`:

| `data-page`                   | Where                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `thread`                      | A thread (and Home, which opens one), a subagent.                                          |
| `chat`                        | A thread that is a chat.                                                                   |
| `new-thread`                  | New thread, a fork being started, opening a folder.                                        |
| `chats`                       | The Chats place with none open.                                                            |
| `history`                     | History and Archived.                                                                      |
| `inbox`                       | Code review's Inbox.                                                                       |
| `pulls`, `pull`               | The pull request list; one pull request or a new one.                                      |
| `issues`, `issue`             | The issue list; one issue or a new one.                                                    |
| `review`                      | Reserved for a code review page; no screen uses it yet.                                    |
| `automations`, `automation`   | Automations with none open; one automation or a new one.                                   |
| `skills`, `skill`             | Skills' landing page; one skill or a new one.                                              |
| `usage`                       | Usage.                                                                                     |
| `spade`                       | Spade, a bot or a group's conversation, and their pages.                                   |
| `projects`, `project`         | Reserved for project pages; projects open in dialogs today.                                |
| `devices`                     | Pairing a device.                                                                          |
| `notifications`               | Reserved; notifications have no page of their own yet.                                     |
| `settings`                    | Every Settings page.                                                                       |
| `setup`, `sign-in`, `connect` | Provider setup; signing in and connecting to a machine (outside the main window's routes). |
| `search`                      | Reserved; search is a sheet (`command-palette`) over the page on screen.                   |

The route each address shows is listed in `apps/web/src/app/route-page.ts`;
`apps/web/src/features/suits/suit-pages-drift.test.tsx` walks every route and fails when its
screen stops naming its page.

## Changes

- Version 1, 2026-11-14: `nav-item` added.
- Version 1, 2026-11-14: pages carry `data-page`; the `page` region reads `--suit-page-*`, `reveal.page` and `scenes.page`.
