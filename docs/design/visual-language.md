# Visual language

The single source for how the ace web app looks and moves. It covers tokens, themes, surfaces,
motion and glass, plus the composer, header and work-log rules every UI change must follow.
Reviewers check UI pull requests against this page.

The approved design prototype is the reference for values. The code that owns each part:

| Part                      | Owner                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| Palettes and neutral ramp | `apps/web/src/theme/palettes.ts`                                                  |
| Palette → CSS variables   | `apps/web/src/theme/tokens.ts`, `apps/web/src/theme/css.ts`                       |
| WCAG checks               | `apps/web/src/theme/contrast.ts`, `apps/web/src/theme/surfaces.ts`                |
| Settings and resolution   | `apps/web/src/theme/appearance.ts`, `theme-provider.tsx`                          |
| Pre-paint replay          | `apps/web/index.html` (inline boot script)                                        |
| Static tokens             | `apps/web/src/styles/tokens.css`                                                  |
| Motion                    | `apps/web/src/styles/motion.css`, `packages/ui-core/src/motion.ts`                |
| Glass                     | `apps/web/src/styles/glass.css`, `apps/web/src/theme/glass.ts`, `liquid-glass.ts` |
| Tailwind mapping          | `apps/web/src/styles/index.css` (`@theme inline`)                                 |

## Rules for every stream

- Use only the semantic tokens below, through their Tailwind utilities (`bg-popover`,
  `text-muted-foreground`, `bg-fill`) or `var(--name)`. Never hard-code a colour.
- Floating layers use `.ace-floating` (or `.ace-floating-solid`). Don't add another blur recipe.
- Time and curves come from `--motion-*` and `--ease-*`. Movement must respect
  `[data-reduce-motion]`.

## Themes and mode

Mode and theme are separate settings.

- **Mode:** Light, Dark or System. System follows `prefers-color-scheme`, and a change
  cross-fades the window.
- **Theme:** Graphite (the default), Ace, Mono, Paper, Dusk, Tide, Ember or Moss.

Every theme shares one **neutral ramp** per scheme: twelve near-true greys generated in OKLCH
(`palettes.ts`). Only Paper and Ember warm the greys, and only slightly (chroma 0.006). A theme's
identity is its accent; Mono's accent is the text colour itself. Status colours never change with
the theme: working is always blue, needs-you amber, waiting violet, failed red and done green. Graphite is pure grey with a
restrained blue, close to T3 Code and Codex.

| Step | Name           | Light   | Dark    | For                                      |
| ---- | -------------- | ------- | ------- | ---------------------------------------- |
| 1    | `canvas`       | #FDFDFD | #161616 | Page and reading column                  |
| 2    | `sidebar`      | #F6F6F6 | #111111 | Sidebar and side panel                   |
| 3    | `surface`      | #F2F2F2 | #1D1D1D | Cards, bubbles, settings groups          |
| 4    | `raised`       | #FFFFFF | #222222 | Floating layers when solid               |
| 5    | `hover`        | #EEEEEE | #262626 | Solid hover fill                         |
| 6    | `active`       | #E7E7E7 | #2D2D2D | Solid pressed or selected fill           |
| 7    | `border`       | #E2E2E2 | #303030 | Hairlines                                |
| 8    | `borderStrong` | #D0D0D0 | #424242 | Control edges, switch tracks (`--input`) |
| 9    | `faint`        | #8C8C8C | #6F6F6F | Decorative icons (3:1)                   |
| 10   | `subtle`       | #636363 | #9E9E9E | Quiet text (`--subtle-foreground`)       |
| 11   | `muted`        | #4A4A4A | #C1C1C1 | Secondary text (`--muted-foreground`)    |
| 12   | `text`         | #191919 | #F0F0F0 | Text (`--foreground`)                    |

(Values shown are Graphite's; warm themes differ by a hair.) Each step is a token by name and by
number: `--neutral-1` … `--neutral-12`.

### Palette fields

| Field                                            | Meaning                                       |
| ------------------------------------------------ | --------------------------------------------- |
| the twelve ramp steps                            | See the table above                           |
| `s0`, `s1`, `s2`                                 | Short names for `canvas`, `surface`, `raised` |
| `t1` / `t2` / `t3`                               | Short names for `text`, `muted`, `subtle`     |
| `accent`, `accentHover`, `accentPressed`         | Accent fill and its states                    |
| `accentFg` / `accentText`                        | Label on an accent fill / the accent as text  |
| `working`, `needs`, `failed`, `done` (+ `…Text`) | Status marks and status words                 |
| `code`, `shadow`                                 | Code background; the shadow tint ("r g b")    |

## Tokens

Theme tokens are generated per palette in `tokens.ts`. The names agreed with shadcn are kept, so
existing components need no edits.

| Purpose                   | Token(s)                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| Page, reading column      | `--background`, `--reading`, `--surface-0`                                        |
| Neutral ramp              | `--neutral-1` … `--neutral-12`, `--hover`, `--active`, `--faint-foreground`       |
| Raised quiet fill         | `--surface-1`, `--card`, `--bubble`                                               |
| Floating (solid)          | `--surface-2`, `--popover`                                                        |
| Sidebar, right panel      | `--sidebar`, `--panel`                                                            |
| Hover and selected washes | `--fill` (= `--accent`, `--muted`), `--fill-strong` (= `--sidebar-accent`)        |
| Controls                  | `--secondary`, `--seg-bg`, `--seg-thumb`, `--seg-thumb-shadow`, `--switch-off`    |
| Lines                     | `--border`, `--border-soft`, `--border-strong` (= `--input`), `--sidebar-border`  |
| Text fields               | `--field` (white with a hairline in light, a quiet lift in dark)                  |
| Text                      | `--foreground`, `--muted-foreground`, `--subtle-foreground`                       |
| Inverse (tooltips, send)  | `--primary`, `--primary-foreground`                                               |
| Accent                    | `--ring`, `--ring-hover`, `--ring-pressed`, `--ring-foreground`, `--ring-text`    |
| Focus                     | `--focus`                                                                         |
| Status                    | `--status-{working,needs-you,waiting,unresponsive,failed,done}` and `…-text`      |
| Errors                    | `--destructive`                                                                   |
| Code                      | `--code`, `--syn-{kw,str,num,fn,type,com}`, `--diff-add`, `--diff-del`            |
| Loading                   | `--skel`, `--skel-hi`                                                             |
| Modal backdrop            | `--scrim` (solid), `--scrim-glass` (over blur); modal panels `--glass-tint-modal` |
| Floating material         | `--float-edge`, `--float-shadow` (= `--glass-shadow`), `--glass-*`, `--sliver`    |
| Project badges            | `--project-1` … `--project-12`                                                    |

Tailwind utilities: `bg-surface-{0,1,2}`, `bg-fill`, `bg-fill-strong`, `bg-scrim`, `bg-tint`,
`bg-tint-hover`, `bg-tint-pressed`, `text-tint-foreground`, `text-link`, and every shadcn name.
`data-tone="<status>"` sets `--tone` and `--tone-text` for dots and words.

To port prototype CSS, translate its names as follows:

- `--surface-*` stays `--surface-*`.
- `--text-1/2/3` becomes `--foreground` / `--muted-foreground` / `--subtle-foreground`.
- `--accent` becomes `--ring`.
- `--accent-fg` becomes `--ring-foreground`.
- `--accent-text` becomes `--ring-text`.
- `--working-text` becomes `--status-working-text`.
- `--needs` becomes `--status-needs-you`.
- `--code-bg` becomes `--code`.

Static tokens (`tokens.css`):

- **Type:** `--font-sans` and `--font-mono`.
- **Layout:** `--header-h`, `--column` and `--composer-control`.
- **Radii:**
  - `--radius-sm` is 8 px, for controls, rows and code.
  - `--radius` is 10 px.
  - `--radius-lg` is 14 px, for bubbles and floating layers.
  - `--radius-xl` is 22 px, for the composer.
- **Density:** `[data-density="compact"]`.

## Surfaces

Settings → Appearance → Surfaces is Translucent (the default) or Solid. `<html>` carries the
resolved value as `data-surface`, which is `solid` in either of these cases:

- the setting is Solid;
- the OS reports `prefers-reduced-transparency: reduce`. Appearance then explains why.

The sidebar, page and right panel are always opaque. Glass only appears on floating layers.

## Glass

There are two classes:

- **`.ace-floating`** is glass under Translucent and `--surface-2` with an edge and shadow under
  Solid.
- **`.ace-floating-solid`** is always solid.

Apply them to every floating layer: popover, menu, select, context menu, hover card, dialog,
tooltip, toast, command palette, Work card and composer strip. The shared primitives already use
them through `overlaySurface` and `popupSurface` in `components/ui/menu-styles.ts`.

Engines:

- **Chromium and Electron** (`data-glass-engine="liquid"`) use
  `backdrop-filter: var(--liquid-filter) blur(12px) saturate(170%)` over a thinner tint.
  - `--liquid-filter` points at an SVG `feDisplacementMap` sized to that layer's own box and
    corner radius (`theme/liquid-glass.ts`).
  - The bending rim is at most 24px deep and bends at most 24px, so a tooltip and a 620px palette
    bend alike. Layers too small for the full rim get a shallower one.
  - Layers of the same size (rounded to 2px) share one filter, and at most 24 unused filters are
    cached.
  - A layer registers itself when it appears: a 1ms marker animation on its `::before` fires
    `animationstart`. One ResizeObserver re-measures it only when it resizes.
  - Until its filter is ready, a layer shows blur only.
- **Safari and Firefox** (`blur`) use `blur(20px) saturate(180%)`. They drop `url()` backdrop
  filters while `CSS.supports` still reports support, so the engine is read from the user agent
  (`glassEngine()`). Every iOS browser counts as WebKit.

Glass parts:

- the tint is `--glass-tint` (blur) or `--glass-tint-liquid` (liquid);
- the inner top highlight is `--glass-inner`;
- the edge is `--glass-edge`;
- a static sheen is `--glass-sheen`;
- the shadow is `--float-shadow`.

Keep glass cheap:

- No per-frame script: the sheen is static and doesn't follow the pointer, and filters are built
  once per layer geometry, after the layer's size has held still for 160ms.
- A layer that resizes as you work (the composer) takes `.ace-glass-flat`: blur glass with no
  displacement filter.
- No filter on large scrolling areas. Sheets and side panels stay solid.

## Motion

| Token           | Value                           | For                                          |
| --------------- | ------------------------------- | -------------------------------------------- |
| `--motion-fast` | 120 ms                          | Hover, colour, press                         |
| `--motion-base` | 200 ms                          | Popovers, menus, tooltips, new rows          |
| `--motion-slow` | 320 ms                          | Panels, sheets, list moves, theme cross-fade |
| `--motion-exit` | 140 ms                          | Anything leaving                             |
| `--ease-out`    | `cubic-bezier(.2, .8, .2, 1)`   | Default deceleration                         |
| `--ease-spring` | `linear(…)` with a light settle | Popovers, segmented thumbs, rows arriving    |
| `--ease-sheet`  | `cubic-bezier(.32, .72, 0, 1)`  | Sheets and panels                            |
| `--ease-exit`   | `cubic-bezier(.4, 0, 1, 1)`     | Leaving                                      |

Animate only `transform` and `opacity`. JS timers read `motionMs` from `@ace/ui-core`.

`bun run check:ui` enforces the static motion policy: no CSS animation may run forever. The
prototype's spinning working marker and shimmering "Working for…" line need the owner to amend
that policy first. Until then, show working state statically.

**Reduce motion** is System, On or Off. `<html>` gets `data-reduce-motion` when the setting is
On, or when it's System and the OS prefers reduced motion. Under it:

- Fades stay. Distances (`--rise`, `--slide`) become 0, `--ease-spring` falls back to `--ease-out`,
  and Base UI popups don't scale.
- Anything marked `.fx-flourish` stops. Use it for sheens, glows and trails such as the Ultra
  effort sheen.
- Fixed slides opt out with `motion-reduce:` utilities. For example, sheets don't slide in from
  the edge and the segmented thumb jumps.
- Pressed controls don't shrink.
- Tailwind's `motion-reduce:` and `motion-safe:` variants follow the attribute, not only the OS.
- In JS, read it with `useReducedMotion()` or `prefersReducedMotion()` from `lib/motion.ts`.

## Modals

Dialogs, sheets and the command palette (`components/ui/dialog.tsx`, `sheet.tsx`, `command.tsx`):

- **Backdrop** (`.ace-backdrop`): under Translucent the page is blurred once, 16px with a light
  saturate, under a faint tint (`--scrim-glass`); there is no dark dim. Under Solid or reduced
  transparency it is a light neutral scrim (`--scrim`). It fades in by opacity with the motion
  tokens; the blur radius never animates.
- **Panel** (`.ace-modal` with `.ace-floating`) for dialogs and the palette: a 90–92% tint over
  the already blurred page, with no blur or displacement of its own, so text and fields read as on
  a solid surface. Sheet panels are solid (`--popover`) over the same backdrop.
- A dialog or sheet is its own surface: settings rows inside it are not rows of the card that
  opened it (`components/ui/surface-context.ts`).
- **Placement:** centred with insets and auto margins, never with a translate. Dialogs centre in
  the window; the palette and search are 640px wide (less on phones), 13vh from the top, and as
  tall as their content.
- **Empty states act:** before a query, search offers recent threads, recent searches and quick
  commands. No explanatory prose.

## Settings

- Pages sit in a column that grows with the window (`--settings-column`, 640–900px).
- Each group is a `SettingSection`: a title, then its rows on a subtle card (`--card`, a hairline
  border, hairlines between rows). Rows that head a page without a title use `SettingCard`.
- Every row is one height (`--setting-row-height`, 52px; 44px compact).
- Inside a card, use the slots, which inset themselves to the card's one left edge:
  `SettingRow` (a setting), `SettingNote` (prose: status lines, what a group does),
  `SettingFooter` (actions, one row tall, at the row's end), `SettingList` of `SettingListItem`s
  (a list of rows), `SettingAction` (a row that is itself the action, "+ Add account") and
  `SettingDisclosure` (a caret row in place of the browser's triangle). Anything else gets a
  margin inset as a fallback; wrap rows in a fragment, never a plain `<div>`, or they inset twice.
- Explanations of a whole group go in the section's `note`, above the card.
- Text fields use `--field`, never a control-border colour.

## First paint

The theme provider writes `ace.boot-appearance` to storage. It holds the settings plus the chosen
theme's CSS. `index.html` replays it before the app's script runs: it resolves System mode,
reduced transparency and reduced motion against the OS, then sets every attribute. A first visit
paints Graphite in the OS scheme. Reloading in any theme or mode never flashes the wrong one.

## Layout rules (approved prototype)

### Composer

- Nothing renders below the composer: no footer, tray, banner or hint.
- There is exactly one strip slot above it. It shows the highest-priority item:
  1. a request (approval, question or plan);
  2. connection;
  3. queue;
  4. plan progress.
- Hidden items show as small clickable indicators inside the strip. A new request always takes
  the slot back.
- There is one model control: `[logo] Model · Effort [speed]`.
  - Standard speed shows no icon, Fast shows one bolt and Ultrafast shows two.
  - It opens one upward popover with two panes:
    - Tune: speed, effort slider, and Ultra with a static sheen under reduced motion;
    - Picker: the model list.
- Send and Stop are fully round.

### Header

- The order is `[title] [⋯] [Work icon] [panel toggle]`.
- The Work icon carries a live dot or a needs-you dot.
- The Work card:
  - is about 280 px wide with 32 px rows;
  - has three groups: Environment, Git and Running;
  - floats beside the transcript without reflowing it when there's room, and is otherwise an
    anchored popover;
  - never covers the composer.

### Work log

- "Working for…" sits at the top of the turn.
- Consecutive tool calls group into one summary row. The newest call stays visible and the rest
  sit behind a toggle. Exploration calls collapse into "Explored …".
- Every row has a real icon (Phosphor). Browser and computer-use rows show the site favicon or the
  app icon.
- A finished turn folds into "Worked for X ›" and loads its steps lazily on expand. These stay
  visible: the final message, failures and still-running subagents.

### Elsewhere

- No narrating chrome: no "Beginning of thread" and no hint prose.
- Side panels draw only the shared rules (see Components): a strip or toolbar edge and a rule
  between sections. Nothing else.
- Code blocks have a Copy button in their header, always visible in a muted ink and a step
  brighter on hover.
- The "ace" wordmark sits at the top of the sidebar.
- The sidebar is a flat task list with three-line rows, never grouped by project.
  - Rows never show the device name.
  - A device icon appears only when more than one device is connected.
- Loading and syncing states are visible.
- Touch targets are at least 32 px on coarse pointers.
- Check layouts at 390, 768, 1440 and 1920 px.

## Components

One component per job. Before drawing something new, use these.

- **Buttons** (`components/ui/button.tsx`), three variants:
  - `primary`: the one action a surface exists for (Allow once, Run now, Take over, Save).
  - `secondary`: any other labelled action. It is outlined, so it reads as a button at rest
    (Stop, Cancel beside a primary, Preview beside a field).
  - `ghost`: actions inside dense chrome (toolbars, row hovers, dialog Cancel).
  - `tone="danger"` colours a ghost or secondary button for destructive actions.
  - Icon-only actions use `IconButton`. There are no pill or black buttons, and no text links
    used as buttons.
- **Separators** (`components/ui/rules.ts`), all on `--border`:
  - `toolbarEdge` under a tab strip or panel toolbar;
  - `sectionRule` above a section that follows another;
  - `listDivider` between the rows of one list or card;
  - `controlDivider` between control groups in a toolbar.
  - Sidebar thread rows never take a rule.
- **Containers** (`components/ui/rules.ts`):
  - `groupCard` for grouped, settings-like content (`SettingCard`, an automation's When / Runs
    on / Recent runs);
  - `rowCard` for one outlined row of a side-panel list (Summary's agents, background commands,
    automations).
  - Everything else is borderless.
- **List rows:** `ViewRow` for page sidebars. The current row is `bg-foreground/8` everywhere,
  including the thread list; hover is the sidebar accent.
- **Add rows:** `SettingAddRow`, a plus icon then the noun ("Add account", "Pair a device",
  "Add machine").
- **Disclosure:** `Disclosure` (`components/ui/disclosure.tsx`) or `SettingDisclosure` inside a
  card. Both turn the same Phosphor caret; the browser's triangle never shows.
- **Select:** `Select` (`components/ui/select.tsx`). Two to three exclusive states, such as
  Open / Closed, use `SegmentedControl`. No native `<select>`.
- **Empty states:** `EmptyState`, `page` for a main pane and `inline` for a list.
- **Icons:** Phosphor only. Account badges and machine marks pick from curated Phosphor sets
  (`account-badge-icons.ts`, `machine-label.tsx`). `bun run check:ui` rejects emoji code points
  in `apps/web/src`.
- **Radii and type:** use the scale tokens (`rounded-sm`, `rounded-md`, `rounded-lg`;
  `text-2xs` to `text-md`). `check:ui` ratchets literal values.

## Old names

The pre-redesign names still resolve, through `apps/web/src/styles/legacy-aliases.css` and the
end of `themeTokens()`, so branches written against them merge cleanly:

- motion: `--dur-1..4`, `--dur-exit`, `--ease`, `--spring`, `--sheet` and `--leave`;
- materials: `--glass-bg`, `--glass-border`, `--wall`, the `-rgb` triples and `--accent-theme`;
- the `glass` Tailwind colours;
- the `.glass`, `.glass-behind`, `.search-glass`, `.vibrancy` and `.wallpaper` classes;
- `motionMs.sheet` and `motionCurves.ease`.

Don't use them in new code. They will be removed once the parallel UI streams have merged.
