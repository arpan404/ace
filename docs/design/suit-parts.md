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
- `:not()`, `:is()` and `:where()` may test only state attributes (`data-state`, `data-variant`,
  `data-page`, `data-scheme`) of the part they follow: `[data-part="button"]:not([data-variant])`,
  `[data-part="tab"]:is([data-state="selected"], [data-state="active"])`. Otherwise their
  selectors name parts, as everywhere.
- Class names, element names, ids and DOM depth are not part of the contract and are refused.

A cursor on the current row, place or tab is one rule each; every list, rail and strip sets its
state as the selection moves:

```css
[data-part="thread-row"][data-state="active"]::before,
[data-part="nav-item"][data-state="active"]::before,
[data-part="tab"][data-state="selected"]::before {
  content: "▶";
}
```

## Protected parts

`working-line`, `approval-strip`, `question-card` and `status-icon` show the state of an agent
(`protectedSuitParts`). A Suit may frame them (spacing, radius, font, border) but ace's guard
layer keeps them visible, unanimated and in ace's colours whatever `suit.css` says.

## Window and regions

| Part             | What and where                                                                                                 | States                                         | Variants          |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------- |
| `app`            | The window's outer frame, behind the sidebar and the canvas. A region.                                         |                                                |                   |
| `rail`           | The narrow column of place glyphs at the sidebar's left. A region.                                             |                                                |                   |
| `rail-item`      | One place in the rail (Threads, Chats, Spade, Code review, Automations, Skills, Usage, Settings, the profile). | `active` (the open place)                      |                   |
| `sidebar`        | The panel beside the rail: the thread list, Settings' pages, Code review's lists. A region.                    |                                                |                   |
| `sidebar-header` | The sidebar panel's title row (its title and search).                                                          |                                                |                   |
| `sidebar-footer` | An empty band along the sidebar panel's bottom edge, for decoration.                                           |                                                |                   |
| `sidebar-tabs`   | The Inbox, Snoozed and Settled pill at the thread list's foot.                                                 |                                                |                   |
| `thread-list`    | The thread list's scrolling area.                                                                              |                                                |                   |
| `thread-row`     | One thread in the list, the filled row itself.                                                                 | `active` (open), `selected` (picked), `unread` |                   |
| `thread-title`   | A thread row's title text.                                                                                     |                                                |                   |
| `thread-meta`    | A thread row's trailing status, PR or line counts (a task row's top line).                                     |                                                |                   |
| `project-header` | The row under the sidebar title with the project filter and New thread.                                        |                                                |                   |
| `header`         | The top bar over the main column. A region.                                                                    |                                                |                   |
| `header-title`   | The top bar's title (the thread's name).                                                                       |                                                |                   |
| `main`           | The main column's content area, under the header.                                                              |                                                |                   |
| `transcript`     | A thread's scrolling transcript. A region.                                                                     |                                                |                   |
| `right-panel`    | The thread's side or bottom panel (Changes, Files, Terminal, Browser).                                         |                                                | `right`, `bottom` |
| `panel-header`   | The side or bottom panel's tab strip row.                                                                      |                                                |                   |

## Transcript

| Part                | What and where                                                                                                                               | States                                            | Variants                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `message-user`      | The person's message bubble.                                                                                                                 |                                                   |                                                                                                                                                 |
| `message-agent`     | An agent's answer, the whole prose block.                                                                                                    |                                                   |                                                                                                                                                 |
| `message-meta`      | The time and copy actions under a message.                                                                                                   |                                                   |                                                                                                                                                 |
| `turn-divider`      | A line across the transcript where the conversation changes hands: a handoff, a fork's start, "Interrupted by you".                          |                                                   | `interrupted`                                                                                                                                   |
| `tool-row`          | One step in the work log ("Ran …", "Edited …").                                                                                              | `working`, `failed`, `open`, `closed`, `done`     | the step's kind: `read`, `search`, `list`, `shell`, `edit`, `web`, `tool`, `think`, `note`                                                      |
| `tool-group-header` | The header row of a group of steps ("Ran 3 commands, read 2 files") that opens the group.                                                    | `working` (its steps still run), `open`, `closed` | the group's kind: `explore`, `mixed`, `edit`, `command`, `computer`, `browser`, `fetch`, `websearch`, `read`, `search`, `list`, `plan`, `spawn` |
| `tool-icon`         | The glyph (or spinner) at the start of a `tool-row`.                                                                                         |                                                   |                                                                                                                                                 |
| `tool-output`       | A step's output, opened under it.                                                                                                            |                                                   | `raw`, `json`                                                                                                                                   |
| `code-block`        | A fenced code block in an answer, with its copy button.                                                                                      |                                                   |                                                                                                                                                 |
| `inline-code`       | Inline code in an answer.                                                                                                                    |                                                   |                                                                                                                                                 |
| `diff`              | A file's diff, opened under an edit step.                                                                                                    |                                                   |                                                                                                                                                 |
| `link`              | A link in an answer, a web link anywhere, and a text link or underlined text button in Settings (Back, Sign in, Check again, a row's title). | `disabled`                                        | `back`, `row` (a row's title, opening its page)                                                                                                 |
| `attachment`        | An attached image tile or file chip.                                                                                                         |                                                   | `image`, `file`                                                                                                                                 |

## Agent state (protected)

| Part             | What and where                                                                                 | States                                 | Variants                                     |
| ---------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| `working-line`   | "Working for 1m 14s" under the running turn.                                                   | `working`, `waiting`                   |                                              |
| `approval-strip` | A request waiting on the person in the composer's strip (an approval, or another kind of ask). | `waiting`                              | the request's kind: `approval`, `browser`, … |
| `question-card`  | An agent's question, open in the strip or answered in the transcript.                          | `waiting`, `done`                      | `question`                                   |
| `status-icon`    | A status glyph: thread rows, agent lines, the hover card.                                      | `working`, `waiting`, `done`, `failed` |                                              |

## Composer

| Part               | What and where                                                                                                                                                                                                                                             | States                                                                  | Variants                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composer`         | The composer's surface. A region.                                                                                                                                                                                                                          |                                                                         |                                                                                                                                                    |
| `composer-input`   | The message field's area.                                                                                                                                                                                                                                  |                                                                         |                                                                                                                                                    |
| `composer-toolbar` | The row of controls under the field.                                                                                                                                                                                                                       |                                                                         |                                                                                                                                                    |
| `composer-send`    | The primary button: Send, Steer, Queue, or Stop.                                                                                                                                                                                                           | `disabled`                                                              | `send`, `steer`, `queue`, `stop`, `stopping`                                                                                                       |
| `model-picker`     | The model chip that opens the model list.                                                                                                                                                                                                                  | `open`, `disabled`                                                      |                                                                                                                                                    |
| `composer-strip`   | The one strip above the composer, around whatever it shows: requests, the queue, sends on their way, the connection, the plan. Not protected: a Suit frames it freely, but while it holds a protected part the guard keeps it shown, opaque and clickable. |                                                                         | what it shows: `request`, `queue`, `sending`, `connection`, `held`, `stopped`, `waiting`, `confirm-stop`, `goal`, `plan`, `transfer`, `automation` |
| `queue-strip`      | The queue in the composer strip: its header, why it is held, its messages.                                                                                                                                                                                 |                                                                         | `paused`                                                                                                                                           |
| `queue-item`       | One queued message.                                                                                                                                                                                                                                        | `selected` (being edited in the composer), `working` (moving or saving) | `saving`, `uncertain` (may already have been sent)                                                                                                 |

## Controls

| Part              | What and where                                                                                                                                                           | States                                           | Variants                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `button`          | A labelled button, and a link or menu trigger drawn as one (Settings' Make one with an agent, Set up, Add).                                                              | `disabled`, `active` (a shortcut being recorded) | `primary`, `secondary`, `ghost`, `danger`; `shortcut` (Keyboard's recorder), `suggestion` (a folder to create) |
| `icon-button`     | A glyph-only button.                                                                                                                                                     | `active` (pressed), `disabled`                   |                                                                                                                |
| `input`           | A text field.                                                                                                                                                            | `disabled`                                       | `multiline`, `search`, `inline`                                                                                |
| `select`          | A select's trigger, and a picker drawn as one (a role's or provider's model).                                                                                            | `disabled`                                       | `model`                                                                                                        |
| `checkbox`        | A checkbox.                                                                                                                                                              | `checked`, `disabled`                            |                                                                                                                |
| `switch`          | A switch's track.                                                                                                                                                        | `checked`, `disabled`                            |                                                                                                                |
| `switch-thumb`    | The knob that slides along a switch's track; read the switch's state: `[data-part="switch"][data-state="checked"] [data-part="switch-thumb"]`.                           |                                                  |                                                                                                                |
| `slider`          | A slider's control and track.                                                                                                                                            | `disabled`                                       |                                                                                                                |
| `slider-thumb`    | The handle dragged along a slider (an element, not a native range thumb).                                                                                                |                                                  |                                                                                                                |
| `tabs`            | A tab strip: the panel's tabs, in-page tabs, a page toolbar's choice of words ("Open · Merged · Closed"), Fleet's views, the command palette's scopes, Spade's computer. |                                                  | `words` (a toolbar's word choice), `fleet`, `search-scope`, `computer`, `model-sources`                        |
| `tab`             | One tab, or one word of a word choice.                                                                                                                                   | `selected` (the one shown or picked), `disabled` | Spade's computer tabs: the surface's kind                                                                      |
| `segmented`       | A one-of-n segmented control (Light / Dark / System, Settings' choices).                                                                                                 | `disabled`                                       |                                                                                                                |
| `segment`         | One segment of it.                                                                                                                                                       | `selected`                                       |                                                                                                                |
| `segmented-thumb` | The pill that slides under the selected segment.                                                                                                                         |                                                  |                                                                                                                |
| `badge`           | A small count or label pill.                                                                                                                                             |                                                  |                                                                                                                |
| `kbd`             | A keyboard shortcut's keys.                                                                                                                                              |                                                  |                                                                                                                |

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

| Part               | What and where                                                                                                                                                                       | States                          | Variants                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------ |
| `settings-nav`     | Settings' list of pages in the sidebar.                                                                                                                                              |                                 |                          |
| `settings-section` | A titled group of settings on a page.                                                                                                                                                |                                 |                          |
| `settings-row`     | One setting: its title, description and control.                                                                                                                                     |                                 |                          |
| `nav-item`         | A row in a sidebar list other than threads (Settings' pages, Skills, Automations, Code review, Spade's agents and groups, the Inbox filters).                                        | `active` (the open page or row) | `agent`, `group` (Spade) |
| `terminal`         | A terminal's screen.                                                                                                                                                                 |                                 |                          |
| `file-tree`        | The Changes or Files tree.                                                                                                                                                           |                                 | `changes`, `files`       |
| `browser-panel`    | The in-app browser's tab, with its toolbar and page.                                                                                                                                 |                                 |                          |
| `empty-state`      | An empty view's message ("No threads yet").                                                                                                                                          |                                 | `inline`                 |
| `scrollbar`        | A scrolling page body with no part of its own (Settings, pages); style its bar with `scrollbar-color` or `::-webkit-scrollbar`. Regions with their own part style theirs through it. |                                 |                          |
| `divider`          | A separator line, in menus and pages.                                                                                                                                                |                                 |                          |

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
| `review`                      | A pull request's Code tab (the review of its changes).                                     |
| `automations`, `automation`   | Automations with none open; one automation or a new one.                                   |
| `skills`, `skill`             | Skills' landing page; one skill or a new one.                                              |
| `usage`                       | Usage.                                                                                     |
| `spade`                       | Spade, a bot or a group's conversation, and their pages.                                   |
| `settings`                    | Every Settings page.                                                                       |
| `setup`, `sign-in`, `connect` | Provider setup; signing in and connecting to a machine (outside the main window's routes). |

The route each address shows is listed in `apps/web/src/app/route-page.ts`;
`apps/web/src/features/suits/suit-pages-drift.test.tsx` walks every route and fails when its
screen stops naming its page.

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

| Part           | What and where                                                                                                                         | States                                                          | Variants                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page-header`  | The title row (Settings, setup); the app mark on a connect card.                                                                       |                                                                 |                                                                                                                                                                                                                                                                                       |
| `page-title`   | The page's heading.                                                                                                                    |                                                                 |                                                                                                                                                                                                                                                                                       |
| `page-toolbar` | A Settings page's controls right of the title; setup's footer; startup's buttons.                                                      |                                                                 |                                                                                                                                                                                                                                                                                       |
| `page-body`    | The content under the title.                                                                                                           |                                                                 |                                                                                                                                                                                                                                                                                       |
| `page-section` | A section that isn't a settings group: setup's "More agents", startup's failure, a devices panel section.                              | `failed` (startup)                                              | `not-installed`, `failure`                                                                                                                                                                                                                                                            |
| `card`         | A settings group's rounded surface; a theme or mode choice and its preview; an accent swatch; the connect card; a running device tile. | `checked` (picker, preview, accent), `open`, `working` (device) | `settings-group`, `picker`, `preview`, `accent`, `connect`, `device`                                                                                                                                                                                                                  |
| `list`         | A list of rows or choices.                                                                                                             |                                                                 | `mode`, `theme`, `accent`, `providers`, `sign-in-choices`, `checks`, `repairs`, `tools`, `models`, `recent-devices`, `running-devices`, `device-kinds`, `problems` (a Suit's needs-fixes list)                                                                                        |
| `list-row`     | One row: a provider, an account, a machine or device, a connected app, a check, a sign-in choice, an add row.                          | `working`, `failed`, `waiting`, `disabled`, `done`, `open`      | `provider`, `account`, `action` (Add …), `grant`, `account-machine`, `device`, `check`, `repair`, `tool`, `sign-in-choice`, `provider-share`, `problem` (one fix a Suit needs, `failed`), Fleet's row kinds, `machine` (Fleet's map list, `selected`), `way` (a way to add a machine) |
| `list-group`   | A disclosure of rows (Settings' folded groups, a device kind, a model picker provider group).                                          | `open`, `closed`, `working`                                     | the device kind or provider                                                                                                                                                                                                                                                           |
| `settings-row` | Also carries a state and variant where one applies: a Suit in Appearance.                                                              | `selected` (in use), `failed` (needs fixes)                     | `suit`                                                                                                                                                                                                                                                                                |
| `stat`         | A headline number on Profile.                                                                                                          | `working` (loading)                                             | `highlight`, `insight`                                                                                                                                                                                                                                                                |
| `chart`        | Profile's activity grid; the Fleet map.                                                                                                |                                                                 | `activity`, `fleet-map`                                                                                                                                                                                                                                                               |
| `progress`     | A usage window's bar, a storage bar, an install or setup bar, setup's step dots.                                                       | `working` (no share yet)                                        | `ok`, `low`, `out` (usage windows), `storage`, `install`, `steps`                                                                                                                                                                                                                     |
| `avatar`       | The person's picture or initials, an account badge, a row's leading tile.                                                              |                                                                 | `picture`, `initials`, `account`, `tile`, `tile-large`                                                                                                                                                                                                                                |
| `label-chip`   | A small word pill: an account's Default, a device's Live.                                                                              |                                                                 | `default`, `live`                                                                                                                                                                                                                                                                     |
| `search-field` | A search field (shared), the sign-in service search, the model search.                                                                 |                                                                 |                                                                                                                                                                                                                                                                                       |
| `filter-bar`   | The devices panel's search and platform filter.                                                                                        |                                                                 |                                                                                                                                                                                                                                                                                       |
| `menu-item`    | A model in the model picker (`option`), its Legacy models row (`submenu`), the Not set / Auto row above it (`checked` when chosen).    | `checked`, `disabled`, `open`, `closed`                         | `option`, `submenu`                                                                                                                                                                                                                                                                   |
| `tabs` / `tab` | The model picker's rail of sources.                                                                                                    | `selected`, `disabled` (tab)                                    | `model-sources` (tabs)                                                                                                                                                                                                                                                                |

## Code review pages

Pull requests, Issues, Inbox, one pull request or issue, and a pull request's Code tab. Each
page's `page` carries `data-page`: `pulls`, `issues`, `inbox`, `pull`, `issue`, or `review` (a
pull request's Code tab). A pull request's or issue's `page` also carries its state as
`data-variant` (`open`, `draft`, `merged`, `closed`; `new` while one is being written), so
`[data-page="pull"][data-variant="merged"]` styles a merged one's whole page.

| Part             | What and where                                                                                                                          | States                                                                                  | Variants                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`           | A whole page in the main column, the list pages' scroller or the pull request's or issue's article. A region.                           |                                                                                         | the state of the pull request or issue on its page, or `new`                                                                                                  |
| `page-header`    | A pull request's or issue's heading: back, actions, title and byline.                                                                   |                                                                                         |                                                                                                                                                               |
| `page-title`     | The title line in a pull request's or issue's heading (or its title editor).                                                            |                                                                                         |                                                                                                                                                               |
| `page-toolbar`   | A list page's bar (project, views, search, its action), and the actions at the right of a pull request's or issue's heading.            |                                                                                         |                                                                                                                                                               |
| `page-body`      | A page's centred reading column under its bar or heading.                                                                               |                                                                                         |                                                                                                                                                               |
| `page-section`   | A titled part of a page: a pull request's Summary blocks and sidebar rows, an issue's About, description, conversation and comment box. | `open`, `closed` (a folding section)                                                    | `filters`, `footer`, `about`, `description`, `conversation`, …                                                                                                |
| `list`           | A list of rows: a list page's rows, an issue's timeline, checks, steps, commits, stack layers.                                          |                                                                                         | `checks`, `steps`, `annotations`, `commits`, `stack`, `attention`                                                                                             |
| `list-row`       | A row with no part of its own: a notification, a merge gate, a reviewer, a check step or annotation, a stack layer.                     | `unread` (a notification), `selected`, `active`, `working`, `waiting`, `done`, `failed` | a notification's subject (`pull-request`, `issue`, …), a gate's tone                                                                                          |
| `list-group`     | A heading band over a group of rows (where checks ran).                                                                                 |                                                                                         |                                                                                                                                                               |
| `card`           | A bordered box: a list page's box, a pull request's description, changes and check detail.                                              |                                                                                         | `description`, `changes`, `check`                                                                                                                             |
| `filter-bar`     | The header row of a list page's box: state toggles and filter menus.                                                                    |                                                                                         |                                                                                                                                                               |
| `search-field`   | A search box, the list pages' search line among them.                                                                                   |                                                                                         |                                                                                                                                                               |
| `avatar`         | A person's round picture or initial.                                                                                                    |                                                                                         |                                                                                                                                                               |
| `label-chip`     | A label's coloured pill, in rows and a pull request's sidebar.                                                                          |                                                                                         |                                                                                                                                                               |
| `pr-row`         | One pull request in the Pull requests list.                                                                                             | `selected` (picked to merge)                                                            | `open`, `draft`, `merged`, `closed`                                                                                                                           |
| `issue-row`      | One issue in the Issues list.                                                                                                           |                                                                                         | `open`, `closed`                                                                                                                                              |
| `pr-header`      | A pull request's header, on its page and in a thread's panel.                                                                           |                                                                                         |                                                                                                                                                               |
| `branch-chip`    | A branch name on its grey chip in a pull request's byline.                                                                              |                                                                                         | `deleted`                                                                                                                                                     |
| `merge-box`      | The Summary's merge box: its gates and the merge button, or how it ended.                                                               | `waiting` (blocked), `done` (merged), `closed`                                          | `open`, `draft`, `merged`, `closed`                                                                                                                           |
| `check-row`      | One check in the Checks tab's list, the local check among them.                                                                         | `selected`, else `working`, `done`, `failed`                                            | its disc: `failed`, `done`, `working`, `idle`, `off`                                                                                                          |
| `commit-row`     | One commit in a push on the timeline, or in a new pull request's commits.                                                               |                                                                                         |                                                                                                                                                               |
| `timeline-item`  | One stop or box on a pull request's or issue's timeline.                                                                                |                                                                                         | `push`, `review`, `comments`, `references`, `event`, `thread`, `composer`, a comment's kind (`issue`, `inline`, `review`), an issue's `comment` or `activity` |
| `review-comment` | One comment or review's words, in the timeline or a review conversation.                                                                |                                                                                         | `issue`, `inline`, `review`                                                                                                                                   |
| `review-thread`  | A review conversation on a line of code.                                                                                                | `working` (an agent fixing it), `done` (resolved), `open`, `closed` (folded)            | `outdated`                                                                                                                                                    |
| `diff-file`      | A file's diff in the Code tab; the code a review conversation is on.                                                                    |                                                                                         | `hunk` (a conversation's code)                                                                                                                                |
| `diff-line`      | One line of a diff.                                                                                                                     |                                                                                         | `add`, `del`, `context`                                                                                                                                       |

The list pages' state toggles are `tabs` and `tab` (`selected`, variant the state), their counts
`badge`; the Views menu's button is a `select`; a filter menu's button is a `button` with variant
`filter` and state `active` while it narrows the list. A state pill is a `badge` whose variant is
the state.

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

## Previews in Settings

Settings > Appearance draws a Suit as it looks, never as a swatch: the Suits list, the Custom
card and the Mode cards each hold a miniature ace window (`apps/web/src/features/settings/suit-preview.tsx`)
built from these parts: `app` (`data-page="thread"`), `rail`, `rail-item` (one `active`),
`sidebar`, `sidebar-header` (with the `sidebar-header` ornament), `thread-list`, `thread-row`
(`active`, `unread`, plain), `status-icon` (`working`, `waiting`, `done`), `thread-title`,
`thread-meta`, `sidebar-footer`, `main`, `header`, `header-title`, `page`, `transcript`,
`message-user`, `message-agent`, `link`, `tool-row` (`edit`, `done`), `inline-code`,
`working-line` (`working`), `composer`, `composer-input`, `composer-toolbar`, `model-picker`,
`composer-send` (`send`), and the four corner ornaments. It runs the Suit's tokens, suit.css,
labels and ace's guard in a shadow root of its own, laid out at 960 × 540 and scaled to the card,
so the Suit on screen never restyles another Suit's miniature. Scenes don't run in it.

## Changes

- Version 1, 2026-11-14: `nav-item` added.
- Version 1, 2026-11-14: side panel parts (`panel-tab`, `panel-body`, `panel-toolbar`,
  `terminal-tab`) and their rows, lists, cards, diff files and diff lines are drawn.
- Version 1, 2026-11-14: pages carry `data-page`; the `page` region reads `--suit-page-*`, `reveal.page` and `scenes.page`.
- Version 1, 2026-11-14: one `page` part per screen, on its canvas (Code review, Settings and
  setup included). `data-page` values no screen set (`projects`, `project`, `devices`,
  `notifications`, `search`) are removed; `review` is a pull request's Code tab, and `/pair`
  shows Settings. A Suit's needs-fixes list is `list` `problems` with `failed` rows.
- Version 1, 2026-11-15: `tool-row` carries the step's kind as `data-variant` (`read`, `search`,
  `list`, `shell`, `edit`, `web`, `tool`, `think`, `note`), so a Suit can mark each kind.
- Version 1, 2026-11-15: Settings previews each Suit in a miniature of real parts (see "Previews
  in Settings"); the Suits list's colour swatch is gone.
- Version 1, 2026-11-15: added `segmented`, `segment`, `segmented-thumb`, `switch-thumb`,
  `slider-thumb`, `tool-group-header`, `tool-icon`, `composer-strip`, `queue-strip` and
  `queue-item`. Selected tabs (`tab`, every strip and word choice), active `nav-item`s (Skills,
  Automations, Code review, Spade) and `rail-item`s set `data-state` as the selection moves;
  buttons and links in Settings carry `button` (with a variant) or `link`; `:not()`, `:is()` and
  `:where()` may test state attributes alone.
