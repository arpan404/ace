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

## Changes

- Version 1, 2026-11-14: `nav-item` added.
