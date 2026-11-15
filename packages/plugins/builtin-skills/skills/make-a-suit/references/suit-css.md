# suit.css cookbook

suit.css is parsed, never applied as text. Each rule that survives is scoped to your Suit and placed in `@layer suit`, after ace's styles and before ace's guard. The full list of parts, with the states and variants each one carries, is `docs/design/suit-parts.md` in the ace repo; this page is the working subset by area.

## Selectors

- Build each compound from `[data-part]`, `[data-page]`, `[data-state]`, `[data-variant]` and `[data-scheme]` with a value (`[data-scheme="dark"]`). Values are short lower-case words.
- Every selector ends on a part: `[data-page="usage"] [data-part="stat"]`, never a bare `[data-page="usage"]`.
- Pseudo-classes: `:hover`, `:focus`, `:focus-visible`, `:focus-within`, `:active`, `:disabled`, `:enabled`, `:checked`, `:empty`, `:placeholder-shown`, the `first-`/`last-`/`only-`/`nth-` family, and `:not()`, `:is()`, `:where()`, `:has()` over the same kind of selectors. `:not()`, `:is()` and `:where()` may also test the part's own state attributes alone: `[data-part="button"]:not([data-variant])`, `[data-part="tab"]:is([data-state="selected"], [data-state="active"])`. Classes, ids and elements are refused inside them too.
- Pseudo-elements: `::before`, `::after`, `::first-letter` (a drop cap on `message-agent`), `::placeholder`, `::selection` and the `::-webkit-scrollbar` family.
- Combinators work as usual (` `, `>`, `+`, `~`). Nesting does not: write each rule in full.
- At-rules: `@media` (width ranges and `prefers-*` features only), `@keyframes`, `@font-face`. Nothing else.

## Colours: read ace's tokens

suit.json sets the colours; suit.css reads them so one rule works in both schemes. Use these:

| Variable                                     | Is                                      |
| -------------------------------------------- | --------------------------------------- |
| `--color-background`                         | `canvas`                                |
| `--color-sidebar`                            | `sidebar`                               |
| `--color-surface-1`, `--color-surface-2`     | `surface`, `raised`                     |
| `--color-hover`, `--color-active`            | `hover`, `active`                       |
| `--color-code`                               | `code`                                  |
| `--color-border`, `--color-border-strong`    | `border`, `borderStrong`                |
| `--color-foreground`                         | `text`                                  |
| `--color-muted-foreground`                   | `muted`                                 |
| `--color-subtle-foreground`                  | `subtle`                                |
| `--color-faint-foreground`                   | `faint`                                 |
| `--color-tint`, `--color-tint-hover`         | `accent`, `accentHover`                 |
| `--color-tint-foreground`                    | `accentFg`                              |
| `--color-link`                               | `accentText`                            |
| `--font-sans`, `--font-prose`, `--font-mono` | `fonts.ui`, `fonts.prose`, `fonts.mono` |

Derive tints with `color-mix(in oklab, var(--color-tint) 18%, transparent)` rather than new hex values. Per-scheme values go under `[data-scheme="dark"] [data-part="composer"]`. Your own variables must start with `--suit-`. Define them on `[data-part="app"]` and on the floating parts (`menu`, `popover`, `dialog`, `tooltip`, `toast`, `command-palette`): those render outside the app part, so a variable defined only on `app` never reaches them, and a declaration that reads it there does nothing.

## Region backgrounds

The regions (`app`, `rail`, `sidebar`, `header`, `transcript`, `composer`, `right-panel`, `page`) read `--suit-<region>-background`, `--suit-<region>-border`, `--suit-<region>-shadow` and `--suit-<region>-backdrop-filter`. Set them on `[data-part="app"]` or on the region itself; a region only reads a variable your CSS names, so unset ones keep ace's look. `--suit-<region>-scene-opacity` sets how much of that region's scene shows. The same values can go in suit.json's `regions` without any CSS.

```css
[data-part="app"] {
  --suit-sidebar-background: linear-gradient(180deg, #14161a, #0f1113);
  --suit-transcript-background: url("assets/paper-grain.webp") repeat, var(--color-background);
  --suit-composer-shadow: 0 8px 32px rgb(0 0 0 / 0.35);
}
```

A region over an `assets/` image is listed in `live.unchecked`: check its contrast in the screenshot.

## By area

**Window and sidebar.** `app`, `rail`, `rail-item` (`active`), `sidebar`, `sidebar-header`, `sidebar-footer`, `sidebar-tabs`, `project-header`, `thread-list`, `thread-row` (`active` open, `selected`, `unread`), `thread-title`, `thread-meta`, `nav-item` (`active`: the open Settings page, skill, automation, Code review list or Spade agent).

The open thread, the open page's row, the current place and the selected tab always carry their state, so a cursor is one rule:

```css
[data-part="thread-row"][data-state="active"]::before,
[data-part="nav-item"][data-state="active"]::before {
  content: "▶";
  color: var(--color-tint);
}
[data-part="rail-item"][data-state="active"] {
  box-shadow: inset 2px 0 0 var(--color-tint);
}
```

```css
[data-part="thread-row"] {
  border-radius: 6px;
}
[data-part="thread-row"]:hover {
  background: var(--color-hover);
}
[data-part="thread-row"][data-state="active"] {
  background: color-mix(in oklab, var(--color-tint) 14%, transparent);
  box-shadow: inset 2px 0 0 var(--color-tint);
}
[data-part="thread-row"][data-state="unread"] [data-part="thread-title"] {
  font-weight: 600;
}
```

**Header.** `header`, `header-title`, `main`.

**Transcript.** `transcript`, `message-user`, `message-agent`, `message-meta`, `turn-divider` (variant `interrupted`), `tool-row` (`working`, `done`, `failed`, `open`, `closed`; variant the step's kind: `read`, `search`, `list`, `shell`, `edit`, `web`, `tool`, `think`, `note`), `tool-group-header` (the row heading a group of steps, "Ran 3 commands": `open`, `closed`, `working`; variant the group's kind), `tool-icon` (the glyph at the start of a `tool-row`), `tool-output` (`raw`, `json`), `code-block`, `inline-code`, `diff`, `link`, `attachment` (`image`, `file`). `layout.messages` and `layout.toolRows` pick the structure; suit.css dresses it.

```css
[data-part="message-user"] {
  background: var(--color-surface-1);
  border: 1px solid var(--color-border);
  border-radius: 14px 14px 4px 14px;
}
[data-part="tool-row"] {
  font-family: var(--font-mono);
}
[data-part="tool-row"][data-state="failed"] {
  border-left: 2px solid var(--color-border-strong);
}
[data-part="code-block"] {
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
[data-part="inline-code"] {
  background: var(--color-code);
  padding: 0 0.3em;
  border-radius: 4px;
}
```

**Composer.** `composer`, `composer-input`, `composer-toolbar`, `composer-send` (variants `send`, `steer`, `queue`, `stop`, `stopping`; state `disabled`), `model-picker` (`open`, `disabled`). Above it, `composer-strip` (variant what it shows: `request`, `queue`, `sending`, `connection`, `plan`, …) holds requests and the queue: `queue-strip` (variant `paused`) and its `queue-item`s (`selected` while edited, `working` while moving; variants `saving`, `uncertain`).

```css
[data-part="composer"] {
  border: 1px solid var(--color-border-strong);
  border-radius: 16px;
  box-shadow:
    0 1px 0 rgb(255 255 255 / 0.04) inset,
    0 12px 40px rgb(0 0 0 / 0.3);
}
[data-part="composer"]:focus-within {
  border-color: var(--color-tint);
}
[data-part="composer-send"][data-variant="send"] {
  border-radius: 999px;
}
```

**Controls.** `button` (`primary`, `secondary`, `ghost`, `danger`; `disabled`; links drawn as buttons are `button` too), `link` (text links and underlined text buttons; variants `back`, `row`), `icon-button` (`active`, `disabled`), `input` (`multiline`, `search`, `inline`), `select` (variant `model` for a model picker drawn as one), `checkbox` / `switch` (`checked`) with its `switch-thumb`, `slider` with its `slider-thumb`, `segmented` (a one-of-n control) with its `segment`s (`selected`) and `segmented-thumb` (the sliding pill), `tabs` (variants `words` for a toolbar's word choice, `fleet`, `search-scope`, `computer`, `model-sources`), `tab` (`selected`), `badge`, `kbd`, `divider`, `scrollbar`.

```css
[data-part="button"][data-variant="primary"] {
  border-radius: 8px;
  letter-spacing: 0.01em;
}
[data-part="switch"][data-state="checked"] [data-part="switch-thumb"] {
  border-radius: 2px;
}
[data-part="segment"][data-state="selected"] {
  font-weight: 600;
}
[data-part="kbd"] {
  border: 1px solid var(--color-border-strong);
  border-bottom-width: 2px;
}
[data-part="scrollbar"] {
  scrollbar-color: var(--color-border-strong) transparent;
}
```

**Side panel and tabs.** `right-panel` (variants `right`, `bottom`), `panel-header`, `panel-tab` (`selected`), `panel-body` (`active`), `panel-toolbar`, `terminal-tab`, `terminal`, `file-tree` (`changes`, `files`), `browser-panel`, `diff-file`, `diff-line` (`add`, `del`, `context`). `panel-tab` and `panel-body` carry the tab's kind as `data-variant`: `changes`, `files`, `terminal`, `browser`, `preview`, `port`, `logs`, `work`, `devices`, `new-tab`, `pull-request`.

```css
[data-part="panel-tab"][data-state="selected"] {
  box-shadow: inset 0 -2px 0 var(--color-tint);
}
[data-part="panel-body"][data-variant="terminal"] {
  background: #0b0d0f;
}
```

**Full pages.** Every page's canvas is `page`, with `data-page` naming it (`thread`, `new-thread`, `chats`, `chat`, `pulls`, `pull`, `issues`, `issue`, `inbox`, `review`, `automations`, `automation`, `skills`, `skill`, `usage`, `spade`, `history`, `settings`, `sign-in`, `setup`, `connect`). Inside: `page-header`, `page-title`, `page-toolbar`, `page-body`, `page-section`, `list`, `list-group`, `list-row`, `card`, `table`, `table-row`, `stat`, `filter-bar`, `search-field`, `avatar`, `label-chip`, `progress`, `chart`. `app` carries the same `data-page`, so a page can restyle the sidebar too.

```css
[data-part="page-title"] {
  letter-spacing: -0.02em;
}
[data-part="card"] {
  border-radius: 12px;
  border: 1px solid var(--color-border);
}
[data-page="usage"] [data-part="stat"] {
  border-left: 3px solid var(--color-tint);
}
[data-page="chat"] [data-part="sidebar"] {
  --suit-sidebar-background: var(--color-background);
}
```

**Pull requests and review.** `pr-row` and the `page` of `pull` carry the state as `data-variant` (`open`, `draft`, `merged`, `closed`); also `issue-row`, `pr-header`, `branch-chip`, `merge-box`, `check-row`, `commit-row`, `timeline-item`, `review-comment`, `review-thread`, `diff-file`, `diff-line`.

```css
[data-part="pr-row"]:hover {
  background: var(--color-hover);
}
[data-part="pr-row"][data-variant="merged"] [data-part="label-chip"] {
  opacity: 0.8;
}
[data-page="pull"][data-variant="merged"] [data-part="page-header"] {
  border-bottom: 1px solid var(--color-border);
}
[data-part="branch-chip"] {
  font-family: var(--font-mono);
  border-radius: 4px;
}
```

**Settings.** `settings-nav`, `nav-item` (`active`), `settings-section`, `settings-row`, and `card` with variant `settings-group` for each group's panel. The `page` of `settings` carries the page's path word as `data-variant` (`appearance`, `providers`, `general`, …).

```css
[data-part="card"][data-variant="settings-group"] {
  border-radius: 14px;
  background: var(--color-surface-1);
}
[data-part="settings-row"] + [data-part="settings-row"] {
  border-top: 1px solid var(--color-border);
}
```

**Menus, dialogs and overlays.** `menu` (`context`, `select`), `menu-item` (`danger`, `submenu`, `radio`, `checkbox`, `option`, `command`; `checked`, `disabled`), `popover`, `dialog` (`sheet`), `tooltip`, `toast` (`plain`, `error`, `warning`, `success`, `info`, `loading`), `command-palette`.

```css
[data-part="menu"],
[data-part="popover"] {
  border: 1px solid var(--color-border-strong);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgb(0 0 0 / 0.4);
}
[data-part="menu-item"]:hover {
  background: color-mix(in oklab, var(--color-tint) 16%, transparent);
}
[data-part="dialog"] {
  border-radius: 18px;
}
```

**Spade and chats.** `spade-message` (variants `user`, `spade`, `bot`, `other`; `working`, `failed`), `chat-row` (`active`, `unread`), `avatar`.

## Decoration

`::before` and `::after` take `content` strings, gradients and `assets/` images. Keep decoration off text-bearing paths and off the guarded parts.

```css
[data-part="sidebar-header"]::after {
  content: "";
  display: block;
  height: 1px;
  margin-top: 8px;
  background: linear-gradient(90deg, var(--color-tint), transparent 70%);
}
[data-part="tool-row"]::before {
  content: "› ";
  color: var(--color-faint-foreground);
}
```

## Fonts

Name fonts in suit.json's `fonts` first; they set ace's own font stacks. For a display face used only by some parts, declare it here and apply it by part:

```css
@font-face {
  font-family: "Suit Display";
  src: url("assets/fonts/display.woff2") format("woff2");
  font-display: fallback;
}
[data-part="page-title"],
[data-part="header-title"] {
  font-family: "Suit Display", var(--font-sans);
}
```

`@font-face` sources must be `.woff2`, `.woff`, `.ttf` or `.otf` files in `assets/`. Give each weight or style its own `@font-face` with `font-weight` / `font-style`.

Bundled fonts never flash a fallback face: when the person switches to your Suit, ace loads every font file from `fonts` and from these `@font-face` rules first (up to 1.5 s) and only then shows the Suit, and font files are cached for as long as the Suit's version stays the same. Keep the files small (subset `.woff2`), so a first switch over a slow link doesn't hit that limit.

## How Settings previews it

Settings > Appearance draws your Suit as it looks: its card in the Look grid and the Light, Dark and System cards each show a small ace window built from real parts (`app`, `rail`, `rail-item`, `sidebar`, `sidebar-header` with its ornament, `thread-list`, `thread-row` with one `active`, `status-icon`, `thread-title`, `thread-meta`, `main`, `header`, `header-title`, `page`, `transcript`, `message-user`, `message-agent`, `link`, `tool-row` (`edit`, `done`), `inline-code`, `working-line`, `composer`, `composer-input`, `composer-toolbar`, `model-picker`, `composer-send`, corner ornaments), with your tokens, suit.css and labels applied, laid out at 960 × 540 and scaled to the card. It is a window of its own: the Suit on screen never reaches it, so write rules from `[data-part]` and `[data-state]` and they show there as in the app. Scenes don't run in it (the frame colour shows), and pages other than `thread` aren't in it.

## Keyframes and transitions

Your keyframe names are scoped to the Suit; refer to them by the name you wrote. Every animation and transition you declare runs only while the device allows motion; under Reduce motion the part shows its resting state. Give infinite animations to backgrounds and ornaments only, never to text.

```css
@keyframes pilot {
  0%,
  100% {
    opacity: 0.6;
  }
  50% {
    opacity: 1;
  }
}
[data-part="sidebar-footer"]::before {
  animation: pilot 4s ease-in-out infinite;
}
[data-part="thread-row"] {
  transition: background-color 120ms ease;
}
```

## Guarded parts

On `working-line`, `approval-strip`, `question-card` and `status-icon` only padding, borders (width, style, colour, radius), font family, weight, style, stretch, text transform and `--suit-` variables survive. Everything else on them is a `css` problem.

`composer-strip` is not guarded: frame and colour it freely. While it holds an approval or question, ace keeps it shown, opaque and clickable whatever your CSS says, so never rely on hiding it.
