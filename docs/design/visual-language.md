# Visual language

The single source for how the ace web app looks and moves. It covers tokens, themes, surfaces,
motion and glass, plus the composer, header and work-log rules every UI change must follow.
Reviewers check UI pull requests against this page.

The approved design prototype is the reference for values. The code that owns each part:

| Part                      | Owner                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| Palettes (the six themes) | `apps/web/src/theme/palettes.ts`                                   |
| Palette → CSS variables   | `apps/web/src/theme/tokens.ts`, `apps/web/src/theme/css.ts`        |
| WCAG checks               | `apps/web/src/theme/contrast.ts`, `apps/web/src/theme/surfaces.ts` |
| Settings and resolution   | `apps/web/src/theme/appearance.ts`, `theme-provider.tsx`           |
| Pre-paint replay          | `apps/web/index.html` (inline boot script)                         |
| Static tokens             | `apps/web/src/styles/tokens.css`                                   |
| Motion                    | `apps/web/src/styles/motion.css`, `packages/ui-core/src/motion.ts` |
| Glass                     | `apps/web/src/styles/glass.css`, `apps/web/src/theme/glass.ts`     |
| Tailwind mapping          | `apps/web/src/styles/index.css` (`@theme inline`)                  |

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
- **Theme:** Ace (the default), Paper, Dusk, Tide, Ember or Moss. Each has a hand-tuned light
  palette and dark palette.

`<html>` carries `data-theme="<id>"` and `data-scheme="light|dark"`. Each theme/scheme pair is one
CSS rule, `[data-theme="tide"][data-scheme="dark"] { … }`. Any element carrying both attributes
gets that theme's real tokens, which is how the Appearance swatches preview themes.

Every palette passes WCAG AA on every surface text can sit on: page, raised, floating, sidebar,
code, glass (blur and liquid tint) over the page and sidebar, and a highlighted row on each of
those. `contrastWarnings()` checks this and a test runs it for all twelve palettes. Quiet text
(`t3`) is one step stronger than the prototype's so it still reads on a highlighted menu row. To
change a palette, edit `palettes.ts` and keep that test green.

### Palette fields

| Field                                            | Meaning                                         |
| ------------------------------------------------ | ----------------------------------------------- |
| `s0`                                             | Page and reading column                         |
| `s1`                                             | Quiet raised fill: bubbles, cards, hunk headers |
| `s2`                                             | Floating layers when solid                      |
| `sidebar`, `border`                              | Sidebar, side panel and hairlines               |
| `t1` / `t2` / `t3`                               | Primary, secondary and quiet text               |
| `accent`, `accentHover`, `accentPressed`         | Accent fill and its states                      |
| `accentFg` / `accentText`                        | Label on an accent fill / the accent as text    |
| `working`, `needs`, `failed`, `done` (+ `…Text`) | Status marks and status words                   |
| `code`, `shadow`                                 | Code background; the shadow tint ("r g b")      |

## Tokens

Theme tokens are generated per palette in `tokens.ts`. The names agreed with shadcn are kept, so
existing components need no edits.

| Purpose                   | Token(s)                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| Page, reading column      | `--background`, `--reading`, `--surface-0`                                       |
| Raised quiet fill         | `--surface-1`, `--card`, `--bubble`                                              |
| Floating (solid)          | `--surface-2`, `--popover`                                                       |
| Sidebar, right panel      | `--sidebar`, `--panel`                                                           |
| Hover and selected washes | `--fill` (= `--accent`, `--muted`), `--fill-strong` (= `--sidebar-accent`)       |
| Controls                  | `--secondary`, `--seg-bg`, `--seg-thumb`, `--seg-thumb-shadow`, `--switch-off`   |
| Lines                     | `--border`, `--border-soft`, `--border-strong` (= `--input`), `--sidebar-border` |
| Text                      | `--foreground`, `--muted-foreground`, `--subtle-foreground`                      |
| Inverse (tooltips, send)  | `--primary`, `--primary-foreground`                                              |
| Accent                    | `--ring`, `--ring-hover`, `--ring-pressed`, `--ring-foreground`, `--ring-text`   |
| Focus                     | `--focus`                                                                        |
| Status                    | `--status-{working,needs-you,waiting,unresponsive,failed,done}` and `…-text`     |
| Errors                    | `--destructive`                                                                  |
| Code                      | `--code`, `--syn-{kw,str,num,fn,type,com}`, `--diff-add`, `--diff-del`           |
| Loading                   | `--skel`, `--skel-hi`                                                            |
| Overlay                   | `--scrim`                                                                        |
| Floating material         | `--float-edge`, `--float-shadow` (= `--glass-shadow`), `--glass-*`, `--sliver`   |
| Project badges            | `--project-1` … `--project-12`                                                   |

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
  `backdrop-filter: url(#ace-liquid-glass) blur(7px) saturate(170%)` over a thinner tint. The SVG
  filter is injected once (`installLiquidGlass`). It uses `objectBoundingBox` units, so a single
  `feDisplacementMap` bends the backdrop at the rim of any layer, at any size.
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

- No per-frame script: the sheen is static and doesn't follow the pointer.
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

**Reduce motion** is System, On or Off. `<html>` gets `data-reduce-motion` when the setting is
On, or when it's System and the OS prefers reduced motion. Under it:

- Fades stay. Distances (`--rise`, `--slide`) become 0, `--ease-spring` falls back to `--ease-out`,
  and Base UI popups don't scale.
- `.fx-shimmer` stops, `.fx-spin` pulses instead of turning, and anything marked `.fx-flourish`
  stops. Use `.fx-flourish` for sheens, glows and trails such as the Ultra effort sheen.
- Tailwind's `motion-reduce:` and `motion-safe:` variants follow the attribute, not only the OS.
- In JS, read it with `useReducedMotion()` or `prefersReducedMotion()` from `lib/motion.ts`.

## First paint

The theme provider writes `ace.boot-appearance` to storage. It holds the settings plus the chosen
theme's CSS. `index.html` replays it before the app's script runs: it resolves System mode,
reduced transparency and reduced motion against the OS, then sets every attribute. A first visit
paints Ace in the OS scheme. Reloading in any theme or mode never flashes the wrong one.

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
- No stray separator lines in side panels.
- Code blocks have copy buttons, shown on hover (always visible on touch).
- The "ace" wordmark sits at the top of the sidebar.
- The sidebar is a flat task list with three-line rows, never grouped by project.
  - Rows never show the device name.
  - A device icon appears only when more than one device is connected.
- Loading and syncing states are visible.
- Touch targets are at least 32 px on coarse pointers.
- Check layouts at 390, 768, 1440 and 1920 px.
