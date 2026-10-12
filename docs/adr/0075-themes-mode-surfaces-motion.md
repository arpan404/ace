# 0075: Eight themes on one neutral ramp, separate mode, surfaces, motion tokens and liquid glass

Date: 2026-10-12. Status: accepted.
Supersedes the "Design tokens" section of [ADR 0045](0045-web-client-stack.md) and its reduced
motion and transparency line. The working spec is
[docs/design/visual-language.md](../design/visual-language.md).

## Context

ADR 0045 described the earlier theme system:

- seven presets generated from seeds, each tied to one scheme (light or dark);
- a pinnable accent and a custom accent;
- a glass-intensity slider over a wallpaper, with a translucent sidebar;
- custom themes made in a theme editor and stored as token files.

The owner approved a redesign prototype on 2026-10-12. It treats light and dark as a mode the
person picks separately from the theme, hand-tunes a small set of themes in both modes, keeps
the window opaque and puts glass only on floating layers.

## Decision

### Mode and theme

- **Mode is its own setting**: Light, Dark or System. System follows `prefers-color-scheme`.
- **Theme** is one of eight: Graphite (the default), Ace, Mono, Paper, Dusk, Tide, Ember or Moss.
  - Amended after the owner's review of the first build ("missing various neutral colors"):
    every theme shares one twelve-step near-true-grey ramp per scheme, generated in OKLCH
    (`apps/web/src/theme/palettes.ts`). Only Paper and Ember warm it slightly; the accent
    carries each theme's identity. Graphite (pure grey, restrained blue) and Mono (accent = text)
    were added.
  - `<html>` carries `data-theme` and `data-scheme`. Each theme/scheme pair is one rule,
    `[data-theme][data-scheme]`.
  - Every palette passes WCAG AA on every surface text sits on. `contrastWarnings` checks this
    and a test runs it for all sixteen palettes.

### Removed

These are replaced by the theme set and Surfaces:

- the accent picker, since a pinned accent would break palettes that were tuned and checked
  together;
- custom themes and the theme editor;
- the glass-intensity slider and the wallpaper;
- desktop vibrancy and Mica.

### Surfaces

- Surfaces is Translucent or Solid.
- Translucent falls back to Solid while the OS reduces transparency.
- `<html>` carries the resolved value as `data-surface`.
- The sidebar, reading column and side panel are always opaque.

### Glass

- Floating layers use `.ace-floating`: popovers, menus, dialogs, tooltips, toasts, the command
  palette, the Work card and the composer strip. The composer is flat glass (`.ace-glass-flat`):
  blur without displacement, since it grows a line at a time.
- **Chromium and Electron** bend the backdrop at the rim with an SVG `feDisplacementMap` through
  `backdrop-filter: url()`.
  - Each layer gets a filter sized to its own box, with a rim of at most 24px and a 24px bend.
  - Layers of the same geometry share a filter, and filters are cached.
  - A layer registers when it appears, through a marker animation's `animationstart`. A single
    ResizeObserver re-measures it only when it resizes. A layer gets its filter at once when it
    opens; after a resize its old rim comes off and a new filter applies once the size has held
    for 160ms.
- Modal layers (dialogs, sheets, the palette) don't use liquid glass. Their backdrop blurs the page
  once with a faint tint (a light neutral scrim when solid), and the panel is a dense tint with no
  blur of its own.
- **Safari and Firefox** get blur and saturate.
  - They drop `url()` backdrop filters while `CSS.supports` still reports support, so the engine
    comes from the user agent.
  - Every iOS browser counts as WebKit.

### Motion

- Tokens: `--motion-fast` (120ms), `--motion-base` (200ms), `--motion-slow` (320ms) and
  `--motion-exit` (140ms).
- Curves: `--ease-out`, a `linear()` spring `--ease-spring`, `--ease-sheet` and `--ease-exit`.
- Reduce motion is System, On or Off. It sets `data-reduce-motion` on `<html>`, which keeps fades
  and drops movement, scaling and flourishes.
- The static motion policy (`bun run check:ui`, which refuses perpetual animations) is unchanged.

### First paint

The theme provider stores `ace.boot-appearance`: the settings plus the chosen theme's rules.
`index.html` replays it before first paint and resolves System against the OS.

### Native status hues

Native status markers (`packages/design-tokens`) use the status colours every theme shares;
status never changes with the theme. A parity test keeps all six statuses equal to what the web
renders in every theme.

### Old names

The pre-redesign token and class names stay as aliases (`styles/legacy-aliases.css`) until the
parallel UI branches written against them (#582, #585, #586) have merged, and are then removed.

## Consequences

- A theme is data. Adding one means adding a light palette and a dark palette and keeping the
  contrast test green; nothing else changes.
- A person can no longer make their own theme or pin an accent. Bringing that back would mean
  editing both palettes of a theme together and running the same contrast checks.
- Liquid glass costs one canvas render per new layer geometry, at most 24 cached filters, and a
  ResizeObserver callback per resize. Nothing runs per frame.
- The desktop window paints a solid background in Graphite's page colour and composites no platform
  material.
