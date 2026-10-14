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
- **Theme** is one of six: Graphite (the default), Midnight, Paper, Slate, Contrast or Aurora.
  - Amended 2026-10-13 (#612): the owner rejected accent-only themes as "too repetitive". Each
    theme now owns its ramp (lightness curve, neutral hue and chroma), contrast, glass and
    default accent. Contrast replaces the old High contrast option. The accent is its own
    setting again (see "Accent").
  - Superseded by the amendment above:
  - Amended after the owner's review of the first build ("missing various neutral colors"):
    every theme shares one twelve-step near-true-grey ramp per scheme, generated in OKLCH
    (`apps/web/src/theme/palettes.ts`). Only Paper and Ember warm it slightly; the accent
    carries each theme's identity. Graphite (pure grey, restrained blue) and Mono (accent = text)
    were added.
  - `<html>` carries `data-theme` and `data-scheme`. Each theme/scheme pair is one rule,
    `[data-theme][data-scheme]`.
  - Every palette passes WCAG AA on every surface text sits on. `contrastWarnings` checks this
    and a test runs it for all sixteen palettes.

### Accent

- **Accent** is its own setting, laid over any theme: the theme's own, six curated colours, Mono
  (the text colour) or a custom hex, stored as `appearance.accent` and `appearance.customAccent`.
- A pinned accent no longer breaks palettes: `accent-fit.ts` fits the chosen colour to each
  theme and scheme (AA labels on every fill state, 3:1 marks, AA links on every surface) and
  nudges it clear of the status colours. A test checks every theme × accent pair.

### Removed

These are replaced by the theme set and Surfaces:

- custom themes and the theme editor;
- the glass-intensity slider and the wallpaper;
- desktop vibrancy and Mica.

### Surfaces

- Surfaces is Translucent or Solid.
  - Amended 2026-10-13: the owner asked for a slider instead. **Translucency** runs in ten steps
    from Solid (0) to the theme's most translucent glass (100%, the default), whose tint is the
    AA-safe floor below. Blur and saturation scale with it, and Solid has no backdrop filter.
    Signal and reduced transparency show it disabled at Solid. A stored Solid became 0 and
    Translucent became the default.
  - Amended 2026-10-14: at 100% the owner said it "still feels like solid", and asked for the
    composer and its strip to be glass too. See "Glass" for the new floor and the composer.
- Translucent falls back to Solid while the OS reduces transparency.
- `<html>` carries the resolved value as `data-surface`.
- The sidebar, reading column and side panel are always opaque.

### Glass

Glass follows Apple's Liquid Glass guidance (HIG "Materials"; WWDC25 "Meet Liquid Glass"): it is
for controls floating above content, never for content, and never glass on glass.

- **Glass** (`.ace-floating`): menus, popovers, selects, context menus, hover cards, toasts, the
  command palette, the Turns panel and floating action bars.
- **Solid** (`.ace-floating-solid`): dialogs, tooltips, the Work card, and anything opened from a
  glass layer.
- **The composer and its strip** (`.ace-glass-dock`, amended 2026-10-14) are glass too, with the
  same slider-driven tint, edged by a border rather than a rim and shadow. They are one material:
  each frosts the transcript directly, and a card attached above the composer is clipped where
  it tucks under the composer's edge, so the composer never frosts already frosted glass. Under
  glass the dock's fade covers only the gap below the composer, so the transcript scrolls
  behind it. Popovers opened from the composer are solid. Primitives pick their material with
  `useFloatingMaterial()`, which reads a context set by the layer they open from, so a menu opened
  from a popover is solid. A DOM-nested floating layer is solid by CSS.
- Translucent resolves to Solid under the Solid setting, while the OS reduces transparency, and in
  a theme with no glass (Signal).
- The material: the backdrop blurred and saturated (per theme); on **Chromium and Electron**, that
  frosted backdrop then bent inside a thin rim by an SVG `feDisplacementMap` through
  `backdrop-filter: url()`, so lensing stays at the edge and never warps text; a tint as thin as
  WCAG AA over realistic backdrops allows (below); a specular rim lit from above; a hairline edge;
  a soft shadow.
  - **The readability floor** (amended 2026-10-14). #661 solved the tint against flat pure white
    and pure black, which forced 74–78% in light and 88–92% in dark and read as solid. A layer
    never shows its backdrop sharp, so the floor is now solved against what the backdrop filter
    actually produces. Four busy fixtures (a dark code editor, a white page with a wide margin,
    a photo with sunlit and shadowed areas, dense black-on-white prose) are blurred with a
    Gaussian of the theme's radius, run through the rest of the filter, and their darkest and
    lightest results are the backdrops text must read over (`theme/backdrops.ts`).
  - Blur alone barely narrows that range, because real content has flat areas wider than any
    blur. The legibility comes from aids instead of opacity, as in Apple's materials: a
    stronger saturation boost; a luminosity scrim (`contrast()` 72% then `brightness()` 114% in
    light, 70% and 72% in dark), which pulls the backdrop's range toward the glass; and text on
    glass a step stronger than on solid surfaces (`--glass-foreground` and the rest, each level
    moved 30–40% toward black in light or white in dark).
  - The floor is the thinnest tint where text and secondary text read at 4.5:1 and quiet hints
    at 3:1 over both backdrops, a selected row's wash included (`theme/glass-floor.ts`). It comes
    out at 52–54% in light and 63–67% in dark. The slider eases toward it along a square root,
    so its middle shows about 70% of what the far end shows instead of reading as solid.
  - Each layer gets a filter sized to its own box at the screen's pixel density, with a rim of at
    most 10px and a 7px bend. The map is encoded off the main thread (`toBlob`).
  - Layers of the same geometry share a filter, and filters are cached.
  - A layer registers when it appears, through a marker animation's `animationstart`. A single
    ResizeObserver re-measures it only when it resizes. A layer gets its filter at once when it
    opens; after a resize its old rim comes off and a new filter applies once the size has held
    for 160ms.
- The palette sits over a backdrop that blurs the page once with a faint tint (a light neutral
  scrim when solid); its panel is the glass tint and rim with no blur of its own. Sheet and dialog
  panels are solid.
- **Safari and Firefox** get blur and saturate.
  - They drop `url()` backdrop filters while `CSS.supports` still reports support, so the engine
    comes from the user agent.
  - Every iOS browser counts as WebKit.

### Motion

- Tokens: `--motion-fast` (120ms), `--motion-base` (200ms), `--motion-slow` (320ms) and
  `--motion-exit` (140ms).
- Curves: `--ease-out`, a `linear()` spring `--ease-spring`, `--ease-sheet` and `--ease-exit`.
- Reduce motion is System, On or Off. It sets `data-reduce-motion` on `<html>`, which keeps fades
  and drops movement, scaling and flourishes. Live activity indicators (spinners, the working
  glyph, pulses) keep running under it; the progress sweep breathes in place.
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
