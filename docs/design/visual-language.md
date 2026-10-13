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
- **Theme:** ace (the default), Folio, Umbra, Signal, Tty or Harbor.
- **Accent:** the theme's own, Blue, Violet, Teal, Green, Amber, Rose, Ink (the text colour) or
  a custom colour. It applies over any theme.

A theme is a material, not an accent. Each owns its neutral ramp, contrast, status hues, code
colours, fonts and glass per scheme. The values come from the approved theme proposal's final
token tables, one file per theme in `src/theme/sources/`. Nothing is generated except the
pressed accent and the shadow tint.

| Theme  | Character                                                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ace    | Zero-chroma greys. The accent is the ink, so Send, focus and caret take the text colour, the selected task is a brighter fill and status is the only colour. No milled edge, grain or material effect |
| Folio  | Warm paper and umber ink, with a mulberry accent. Transcript prose is serif; the UI stays sans                                                                                                        |
| Umbra  | The darkest canvas, on one plane, with text held back from white and a verdigris accent                                                                                                               |
| Signal | Black on white, 3:1 borders, AAA status words, ink accent, solid layers, full focus rings                                                                                                             |
| Tty    | All monospace, with a chartreuse cursor accent and a teal "done"                                                                                                                                      |
| Harbor | Cool slate at mid contrast, with a petrol accent                                                                                                                                                      |

The sources clear AA on the proposal's surfaces: page, sidebar, cards, floating, hover, active
and code. The app also draws text on glass and on selected-row washes, and its faint icons need
3:1. `palettes.ts` steps any role that falls short there toward black (light) or white (dark)
just far enough. Every other value is used exactly as given.

Any other accent is fitted to the theme and scheme it lands on (`accent-fit.ts`):

- Light themes deepen it until white labels read at AA. A bright colour such as amber keeps its
  brightness and takes a deep label instead.
- Dark themes brighten it until a deep label reads.
- Links step toward the text colour until they read on every surface.
- An accent within ΔE 10 of a status colour is nudged clear of it. One boxed in on every side
  becomes the ink.

Status colours belong to the theme and never change with the accent. Working is always blue,
needs-you amber, failed red and done green. Waiting (violet) and not-responding (pink) are shared
by every theme.

| Step | Name           | Light   | Dark    | For                                      |
| ---- | -------------- | ------- | ------- | ---------------------------------------- |
| 1    | `canvas`       | #FFFFFF | #121212 | Page and reading column                  |
| 2    | `sidebar`      | #F7F7F7 | #0C0C0C | Sidebar and side panel                   |
| 3    | `surface`      | #F2F2F2 | #1A1A1A | Cards, bubbles, settings groups          |
| 4    | `raised`       | #FFFFFF | #1F1F1F | Floating layers when solid               |
| 5    | `hover`        | #EFEFEF | #1C1C1C | Solid hover fill                         |
| 6    | `active`       | #E9E9E9 | #2A2A2A | Solid pressed or selected fill           |
| 7    | `border`       | #E6E6E6 | #262626 | Hairlines                                |
| 8    | `borderStrong` | #CCCCCC | #383838 | Control edges, switch tracks (`--input`) |
| 9    | `faint`        | #939393 | #636363 | Decorative icons (3:1)                   |
| 10   | `subtle`       | #646464 | #979797 | Quiet text (`--subtle-foreground`)       |
| 11   | `muted`        | #454545 | #B2B2B2 | Secondary text (`--muted-foreground`)    |
| 12   | `text`         | #111111 | #F0F0F0 | Text (`--foreground`)                    |

(Values shown are ace's; every other theme has its own.) Each step is a token by name and by
number: `--neutral-1` … `--neutral-12`. Each theme also sets `--font-sans`, `--font-prose`
(transcript text, the `font-prose` utility) and `--font-mono`, all system stacks.

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
| `diffAdd`, `diffDel` (+ `…Fg`), `syntax`         | Diff rows and their gutter text; code colours |

## Tokens

Theme tokens are generated per palette in `tokens.ts`. The names agreed with shadcn are kept, so
existing components need no edits.

| Purpose                   | Token(s)                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| Page, reading column      | `--background`, `--reading`, `--surface-0`                                       |
| Neutral ramp              | `--neutral-1` … `--neutral-12`, `--hover`, `--active`, `--faint-foreground`      |
| Raised quiet fill         | `--surface-1`, `--card`, `--bubble`                                              |
| Floating (solid)          | `--surface-2`, `--popover`                                                       |
| Sidebar, right panel      | `--sidebar`, `--panel`                                                           |
| Hover and selected washes | `--fill` (= `--accent`, `--muted`), `--fill-strong` (= `--sidebar-accent`)       |
| Controls                  | `--secondary`, `--seg-bg`, `--seg-thumb`, `--seg-thumb-shadow`, `--switch-off`   |
| Lines                     | `--border`, `--border-soft`, `--border-strong` (= `--input`), `--sidebar-border` |
| Text fields               | `--field` (white with a hairline in light, a quiet lift in dark)                 |
| Text                      | `--foreground`, `--muted-foreground`, `--subtle-foreground`                      |
| Inverse (tooltips, send)  | `--primary`, `--primary-foreground`                                              |
| Accent                    | `--ring`, `--ring-hover`, `--ring-pressed`, `--ring-foreground`, `--ring-text`   |
| Focus                     | `--focus`                                                                        |
| Status                    | `--status-{working,needs-you,waiting,unresponsive,failed,done}` and `…-text`     |
| Errors                    | `--destructive`                                                                  |
| Code                      | `--code`, `--syn-{kw,str,num,fn,type,com,punc}`, `--diff-{add,del}` (+ `-text`)  |
| Loading                   | `--skel`, `--skel-hi`                                                            |
| Modal backdrop            | `--scrim` (solid), `--scrim-glass` (over blur)                                   |
| Floating material         | `--float-edge`, `--float-shadow` (= `--glass-shadow`), `--glass-*`, `--sliver`   |
| Project badges            | `--project-1` … `--project-12`                                                   |
| Chat visualization series | `--chart-1` … `--chart-6`                                                        |

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

- **Type:** defaults for `--font-sans`, `--font-prose` and `--font-mono`; each theme sets its own.
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

Glass follows Apple's Liquid Glass guidance
([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials),
[WWDC25 "Meet Liquid Glass"](https://developer.apple.com/videos/play/wwdc2025/219/)). It is for
controls and navigation floating above content, never for content itself, and never glass on
glass.

There are two classes:

- **`.ace-floating`** is glass under Translucent and `--surface-2` with an edge and shadow under
  Solid. Use it for menus, popovers, selects, context menus, hover cards, toasts, the command
  palette, the Turns panel and floating action bars.
- **`.ace-floating-solid`** is always solid. Use it for dialogs, tooltips, the Work card, the
  composer and its strip, and anything that holds content.

The shared primitives pick the material themselves: `useFloatingMaterial()`
(`components/ui/floating-material.tsx`) returns `ace-floating-solid` for a layer opened from a
glass layer, so a menu opened from a popover is solid. A floating layer nested in another in the
DOM is solid by CSS. `popupFrame` in `components/ui/menu-styles.ts` is a popup's shape without
its material.

`data-surface` is "solid" under the Solid setting, while the OS reduces transparency, and in a
theme with no glass (Signal). Nothing the stylesheet ships has a backdrop filter then
(`apps/web/motion-css.test.ts` checks the built CSS).

The material, in order:

1. The backdrop is blurred and saturated: `--glass-blur` and `--glass-saturate`, set per theme
   and scheme in `theme/sources/` (dark schemes blur more).
2. **Chromium and Electron** (`data-glass-engine="liquid"`) then bend that frosted backdrop at the
   rim: `backdrop-filter: blur() saturate() var(--liquid-filter)`.
   - `--liquid-filter` points at an SVG `feDisplacementMap` sized to that layer's box, corner
     radius and pixel density (`theme/liquid-glass.ts`).
   - The rim is at most 10px deep and bends at most 7px, on a smooth curve that meets the flat
     middle with no seam. Inside the rim the map is exactly neutral, so text behind a layer is
     never warped. Layers too small for the full rim get a shallower one.
   - The map is drawn at device pixels and encoded off the main thread (`toBlob`). Layers within
     a pixel of a filter's size keep it, and at most 16 unused filters are cached.
   - A layer registers itself when it appears: a 1ms marker animation on its `::before` fires
     `animationstart`. One ResizeObserver re-measures it only when it resizes.
   - Until its filter is ready, a layer shows the frosted backdrop only.
3. The tint is `--glass-tint`: `--surface-2` at the thinnest opacity over which text and
   secondary text read at AA (4.5:1) and quiet hints at 3:1 over a white and a black backdrop,
   selected rows included (`glassTintAlpha` in `theme/surfaces.ts`).
4. The specular rim is `--glass-rim`: inset hairlines lit from above (a bright crescent along the
   top, a faint line all round, a weaker return at the bottom).
5. The edge is `--glass-edge` and the shadow is `--float-shadow`.

**Safari and Firefox** (`blur`) get steps 1, 3, 4 and 5. They drop `url()` backdrop filters while
`CSS.supports` still reports support, so the engine is read from the user agent (`glassEngine()`).
Every iOS browser counts as WebKit.

The command palette (`.ace-modal`) sits over `.ace-backdrop`, which blurs the page once, so the
panel has the tint and rim with no blur of its own.

Corners are concentric: rows inside a 14px popup with 4px padding are 10px (`rounded-md`).

Keep glass cheap:

- No per-frame script. Filters are built once per layer geometry.
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

Only live-activity indicators run forever: the spinner, the working glyph's walk, the sidebar's
dashed working mark, the startup mark's breath, the indeterminate progress sweep and Tailwind's
`animate-pulse`. Each shows work happening right now and goes away when it ends. They move only
transform or opacity and pause and dim only while the daemon is unreachable (reconnecting,
offline or failed), never while it connects or starts. They keep running under reduced motion, as
macOS keeps its own activity indicators: a still spinner reads as a hung app. The progress sweep,
the one that travels, breathes in place instead.
`bun run check:ui` refuses any other `infinite` animation, and `apps/web/motion-css.test.ts`
builds the stylesheet to check every animation it names has keyframes.

**Reduce motion** is System, On or Off. `<html>` gets `data-reduce-motion` when the setting is
On, or when it's System and the OS prefers reduced motion. Under it:

- Fades stay. Distances (`--rise`, `--slide`) become 0, `--ease-spring` falls back to `--ease-out`,
  and Base UI popups don't scale.
- Live activity indicators keep running (see above).
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
paints ace in the OS scheme. Reloading in any theme or mode never flashes the wrong one.

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

- **Buttons** (`components/ui/button.tsx`), four variants:
  - `primary`: the one action a surface exists for (Allow once, Run now, Take over, Save).
  - `secondary`: any other labelled action. It is outlined, so it reads as a button at rest
    (Stop, Cancel beside a primary, Preview beside a field).
  - `ghost`: actions inside dense chrome (toolbars, row hovers, dialog Cancel).
  - `danger`: the confirming action of a destructive confirmation (Delete, Stop and delete,
    Remove project, Revoke, Discard, Stop & archive). A solid fill in the theme's failed hue
    with a white label at AA (`theme/danger.ts`). The footer reads Cancel, then the danger
    action, right-aligned, and focus starts on Cancel with a quiet hairline ring.
  - `tone="danger"` colours a ghost or secondary button that opens a destructive confirmation,
    or a destructive row action. Destructive menu items stay red text.
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
