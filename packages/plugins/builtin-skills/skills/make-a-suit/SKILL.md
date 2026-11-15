---
name: make-a-suit
description: Restyle ace as a Suit the person describes, check it as rendered, then preview it.
---

# Make a Suit

A Suit is a whole look for ace: colours, fonts, shape, layout, styles for every part of the UI, ornaments, short labels and animated scenes. The person describes it ("a technical drawing", "a green terminal"); you write the files, `suit_apply` checks them and shows them, and you fix what the checks and the screenshot show. Tool names: Claude Code `mcp__ace__suit_apply`; OpenCode and Pi `ace_suit_apply`.

## The folder

```
~/.ace/suits/<id>/
  suit.json     colours, fonts, shape, motion, layout, labels, ornaments, scenes, reveal
  suit.css      optional: styles for the published parts
  scene.js      optional: the app's animated backdrop; other regions name their own .js files
  assets/       optional: fonts, images, ornament .svg/.html files
```

Start from a shipped Suit: copy its folder to the new id and change `id`. `warm-paper` is colours only; `starfield` adds a scene; `blueprint` is suit.css, grid backgrounds and ornaments without a scene; `phosphor` uses layout, labels and a scene; `neon-district` uses everything, including a sidebar scene.

## The loop

1. **Write** the files. The id is lower-case words joined by dashes, up to 48 characters, and is the folder name.
2. **Preview**: `suit_apply { mode: "preview", id }`. The static checks run first; if any fail you get `status: "refused"` with `problems` and nothing applies. There is no "apply anyway".
3. **Read what the devices saw.** A preview that applies is checked live on the person's open ace windows. The result has `problems` from the live check (`live-contrast`, `protected`, `overflow`, with `field` naming the part), `live.devices` (who checked, at which widths) and, from the desktop app, a screenshot of ace in the Suit. `live.source: "static"` means no window answered in time: look yourself with `browser_open` and `browser_screenshot` on ace's web app. A browser tab sends no screenshot.
4. **Fix and save.** Fix each problem's `field`, change nothing else, save. Every save re-runs the checks and swaps the Suit into the open app without a reload; preview again to get fresh live problems and a new screenshot. Repeat until `problems` is empty and the screenshot looks like what the person asked for.
5. **Ask** the person within the turn (`ask`, or your own question tool), then `suit_apply { mode: "keep" }` or `{ mode: "revert" }`. A preview ends with your turn, so a question in your reply ends it too: then say how to get it back ("say _keep blueprint_"), and next turn `keep` with that `id`. After a keep, one `revert` brings back the look before it.

## suit.json

```json
{
  "format": 1,
  "id": "blueprint",
  "name": "Blueprint",
  "description": "Grid paper, chalk linework on drafting blue.",
  "base": "midnight",
  "dark": { "canvas": "#10294A", "text": "#F2F6FB", "accent": "#F5F1E6" },
  "fonts": { "ui": { "system": "ui-monospace, Menlo, monospace" } },
  "shape": { "radius": 0.2, "border": 1, "density": "comfortable" },
  "layout": { "messages": "flat", "toolRows": "detailed" },
  "labels": { "composer-placeholder": "Specify the next change…" },
  "ornaments": [{ "slot": "sidebar-footer", "asset": "assets/title-block.svg" }],
  "scenes": { "app": "scene.js", "sidebar": "sidebar.js" },
  "reveal": { "app": 0.5, "sidebar": 0.4 }
}
```

| Field                 | Limits                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`              | Always `1`. `id` matches the folder. `name` 1–60 characters, `description` up to 280, `version` up to 40.                                                                                                                                                           |
| `base`                | `ace` (default), `paper`, `midnight`, `grove`, `harbor` or `dusk`. Every colour you leave out comes from it.                                                                                                                                                        |
| `light`, `dark`       | At least one. A Suit with one scheme runs only in that scheme. Colours are `#RRGGBB` only.                                                                                                                                                                          |
| `fonts.ui/prose/mono` | `{ "system": "<family list>" }` or `{ "asset": "assets/<file>", "family": "<name>" }`. No remote fonts.                                                                                                                                                             |
| `shape`               | `radius` 0–2 (multiplies every corner), `border` 0.5–2 px, `density` `compact`, `comfortable` or `spacious`. `motion.speed` 0.5–2.                                                                                                                                  |
| `layout`              | `sidebar` `left`/`right`; `rail` `shown`/`hidden`/`merged`; `sidebarWidth` 200–480; `transcriptWidth` 560–1400; `composer` `docked`/`floating`; `header` `bar`/`minimal`/`hidden`; `messages` `bubbles`/`flat`/`cards`; `toolRows` `compact`/`detailed`/`terminal`. |
| `labels`              | Up to 40 characters each: `composer-placeholder`, `empty-transcript`, `empty-sidebar`, `working-word`, `send`. Status words are never replaceable.                                                                                                                  |
| `ornaments`           | Up to 16 `{ slot, asset }`. Slots: `sidebar-header`, `sidebar-footer`, `transcript-top`, `empty-state`, `composer-top`, `corner-top-left`, `corner-top-right`, `corner-bottom-left`, `corner-bottom-right`.                                                         |
| `scenes`              | Region → `.js` file at the Suit's root, for `app`, `sidebar`, `header`, `composer`. `scene.js` alone means `{ "app": "scene.js" }`.                                                                                                                                 |
| `reveal`              | Region → 0–1: how much of its scene or background shows through its surface (`app`, `rail`, `sidebar`, `header`, `transcript`, `composer`).                                                                                                                         |
| `scene`               | Don't write it: ace sets it.                                                                                                                                                                                                                                        |

Palette fields per scheme: surfaces `canvas`, `sidebar`, `surface`, `raised`, `hover`, `active`, `code`; lines `border`, `borderStrong`; text `text`, `muted`, `subtle`, `faint` (icons only); accent `accent`, `accentHover`, `accentFg` (labels on an accent fill), `accentText` (links); diff `diffAdd`, `diffDel`, `diffAddFg`, `diffDelFg`; `syntax.kw/fn/str/num/type/com/punc`; `glass: { blur 0–64, saturate 100–300 }` or `null` for solid floating layers. Set surfaces and text levels together, as one ramp.

## Parts and suit.css

Every region and repeated element of ace carries `data-part="<name>"`, its state in `data-state` (`active`, `selected`, `open`, `closed`, `disabled`, `checked`, `hover`, `working`, `waiting`, `done`, `failed`, `unread`) and its variant in `data-variant`. The parts and what each one is are in `docs/design/suit-parts.md`; they are the only names suit.css may use.

- **Selectors** are built only from `[data-part]`, `[data-state]`, `[data-variant]`, `[data-scheme]`, pseudo-classes (`:hover`, `:focus-within`) and pseudo-elements (`::before`, `::after`). A selector naming a class, an id or an element is refused. ace scopes every rule to your Suit and puts it in `@layer suit`.
- **Allowed**: anything visual. Backgrounds (gradients, patterns, your own `assets/` images), borders, radius, shadows, filters, backdrop filters, fonts, letter spacing, text transform, `::before`/`::after` decoration, transitions and keyframe animations. Use ace's colour variables (`var(--color-foreground)`, `var(--color-border-strong)`) so one rule works in both schemes.
- **Refused**: `@import`, `url()` to anything but your `assets/`, `expression`, `behavior`, `-moz-binding`, `content: attr(...)`. Each refusal comes back as a `css` problem with its line.
- **Region backgrounds without CSS**: the sidebar, rail, header, transcript, composer and floating layers read `--suit-<part>-background`; set it on `[data-part="app"]`. `--suit-<part>-scene-opacity` sets how much of a region's scene shows, within what readability allows.

```css
[data-part="transcript"] {
  background-image:
    linear-gradient(
      color-mix(in srgb, var(--color-foreground) 6%, transparent) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--color-foreground) 6%, transparent) 1px,
      transparent 1px
    );
  background-size: 20px 20px;
}
[data-part="thread-row"][data-state="active"] {
  box-shadow: inset 2px 0 0 #ff2d95;
}
[data-part="tool-row"]::before {
  content: "› ";
}
```

**Ornaments** are static SVG or HTML in `assets/`: no script, no event handlers, no external references. They are inserted inline, so `fill="currentColor"` and `stroke="currentColor"` follow the scheme.

## What a Suit can never change

The guard layer (`@layer guard`) comes after yours and keeps an agent's state readable: the approval strip, the Working line, waiting and failed markers, status icons and focus rings (`working-line`, `approval-strip`, `question-card`, `status-icon`) keep their display, full opacity, a minimum size, ace's colours and their pointer events, with no animation on them, and nothing may cover them. Suit animations stop under Reduce motion, and infinite ones run only on decorative parts. You may frame the protected parts (spacing, radius, font); don't try to recolour, hide or cover them. Your accent must stay clearly apart from the status colours (below).

## Checks

Static, before anything applies:

| Check                        | Passes when                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                     | `suit.json` parses within the limits above.                                                                                                                    |
| `contrast`                   | `text`, `muted`, `subtle` and `accentText` reach 4.5:1 on every surface; `faint` and `accent` 3:1 on `canvas`; `accentFg` 4.5:1 on `accent` and `accentHover`. |
| `accent-fit`                 | `accent` isn't mistakable for a status colour (blue working, amber needs you, red failed, green done, violet waiting, pink unresponsive).                      |
| `glass-floor`                | Text on glass reads at 4.5:1 over frames sampled from your scenes.                                                                                             |
| `css`                        | Every suit.css rule survives the sanitiser.                                                                                                                    |
| `asset`, `ornament`, `scene` | Files exist inside the folder, ornaments sanitise cleanly, scenes load, call `ace.scene` and draw.                                                             |

Live, on the person's open ace windows after a preview or keep:

| Check           | Passes when                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-contrast` | Every part's text reaches 4.5:1 (3:1 at 24 px, or 18.66 px bold) and its icons 3:1 over what is actually behind it: your backgrounds, gradients, opacity and the scene's pixels. |
| `protected`     | Each protected part on screen is displayed, at full opacity, at least its minimum size, and is the topmost thing at its centre.                                                  |
| `overflow`      | No part reaches past its region or spills its content, at the window's width and at 1024 and 760 px (simulated by narrowing the app; media queries keep the real width).         |

`live.unchecked` lists parts over an `assets/` image, whose contrast the check can't read: look at those in the screenshot.

### Reading problems

Each problem is `{ scheme, check, field, message }`; fix that `field` in that scheme and nothing else. Typical fixes:

- `contrast` on `muted`/`subtle`: move the text colour away from the surfaces, or the surfaces closer to `canvas`. `accentText`: a step darker (light) or lighter (dark) than `accent`. `accentFg`: white or near-black, whichever reads.
- `accent-fit`: turn the hue 20–40° toward the middle of a gap (bronze, warm orange, ice blue) or drop the chroma toward chalk or graphite; don't nudge one digit.
- `live-contrast` on a part: the message names the colours as rendered. Make that part's background in suit.css more opaque, darken or lighten it, or lower the region's `reveal` over a busy scene.
- `protected`: remove the rule, ornament or `::before`/`::after` that hides, fades or covers the part.
- `overflow`: drop a fixed width, reduce padding or let the text wrap in that part.
- `glass-floor`: darken the scene behind the sidebar and transcript, or set `glass` to `null`.

## Scenes

A scene is an animated backdrop for one region. Leave it out unless the look truly moves.

**The sandbox.** It runs in a sandboxed, opaque-origin iframe and draws on one canvas (2D or WebGL); it can load images from its own `assets/`. No network, no storage, no access to ace's page, no thread contents, names or paths.

**The runtime.** Register once:

```js
ace.scene({
  init(view) {}, // view: { canvas, width, height, pixelRatio, scheme, reduceMotion }
  frame(time, view) {}, // draw one frame; time in ms of ace's scene clock
  signal(name) {}, // "working", "waiting", "done", "failed" or "pr-merged"
  resize(view) {},
  scheme(scheme) {}, // "light" or "dark"
});
```

ace owns the clock: `frame` comes at 30 fps at most and stops when the window is hidden, unfocused for a while or on battery saver. Under Reduce motion `frame` comes once with `view.reduceMotion` true: draw a calm still frame. Stamp signal moods with the last `frame` time, not `performance.now()`. Signals are moods, never state: a short reaction, since ace's markers already show state.

**Performance.** Allocate in `init` and `resize`; `frame` reuses objects and draws. Keep a frame well under 4 ms: a few hundred shapes in 2D or one shader pass, no per-pixel JavaScript, no per-frame filters or image decoding. Size the canvas `width × pixelRatio` by `height × pixelRatio`, capped at 2. Keep it low in contrast behind text. A scene that throws, misses its budget three times or fails to load is stopped and the Suit carries on without it. A scene that draws images from `assets/` can't be sampled by the live check, so the text over it is listed in `live.unchecked`.

## Done when

`suit_apply` returned no problems, the screenshot (or your own `browser_screenshot`, in each scheme the Suit has) looks like what the person asked for, and the person chose keep or revert.
