---
name: make-a-suit
description: Restyle ace as a Suit the person describes, then preview it.
---

# Make a Suit

A Suit is a look for ace: colours, fonts, shape, motion and an optional animated backdrop. The person describes it ("warm paper", "neon synthwave"); you write the files, check them with `suit_apply`, and show the result. Tool names: Claude Code `mcp__ace__suit_apply`; OpenCode and Pi `ace_suit_apply`.

## The loop

1. **Pick an id**: lower-case words joined by dashes, up to 48 characters (`synthwave-sunset`). It is the folder name.
2. **Write** `~/.ace/suits/<id>/suit.json`, and `scene.js` only if the look moves. To start from a shipped Suit, copy `~/.ace/suits/warm-paper` (colours only) or `~/.ace/suits/starfield` (with a scene) to the new id and change its `id`.
3. **Preview**: `suit_apply { mode: "preview", id }`. It runs every check first. If any fail you get `problems` and nothing is applied; fix them (see [Reading problems](#reading-problems)) and preview again. There is no "apply anyway".
4. **Look**: `browser_open` ace's web app, then `browser_screenshot`, in both schemes if the Suit has both. The person sees the preview on their devices too.
5. **Ask** the person within the turn (`ask`, or your own question tool), then `suit_apply { mode: "keep" }` or `{ mode: "revert" }`. A preview ends with your turn, so a question in your reply ends it too: then say how to get it back ("say _keep warm-paper_"), and next turn `keep` with that `id`. After a keep, one `revert` brings back the look before it.

## suit.json

```json
{
  "format": 1,
  "id": "warm-paper",
  "name": "Warm paper",
  "description": "Cream pages and ink-brown text, like a notebook.",
  "base": "paper",
  "light": { "canvas": "#FBF4E6", "text": "#2B2116", "accent": "#8F4A12" },
  "dark": { "canvas": "#1B1610", "text": "#ECE3D3", "accent": "#E8A867" },
  "fonts": { "prose": { "system": "Iowan Old Style, Georgia, serif" } },
  "shape": { "radius": 1.2, "border": 1, "density": "comfortable" },
  "motion": { "speed": 1 }
}
```

| Field                 | Limits                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `format`              | Always `1`.                                                                                                                    |
| `id`                  | Same as the folder name.                                                                                                       |
| `name`                | 1–60 characters. `description` up to 280, `version` up to 40 (display only).                                                   |
| `base`                | `graphite` (default), `midnight`, `paper`, `slate`, `contrast` or `aurora`. Every colour you leave out comes from it.          |
| `light`, `dark`       | At least one. A Suit with one scheme runs only in that scheme.                                                                 |
| colours               | `#RRGGBB` only: no alpha, names or `rgb()`.                                                                                    |
| `fonts.ui/prose/mono` | `{ "system": "<family list>" }` (up to 200 characters) or `{ "asset": "assets/<file>", "family": "<name>" }`. No remote fonts. |
| `shape.radius`        | 0–2, multiplies every corner radius. `shape.border` 0.5–2 px. `shape.density` `compact`, `comfortable` or `spacious`.          |
| `motion.speed`        | 0.5–2, multiplies animation durations.                                                                                         |
| `scene`               | Don't write it: ace sets it from whether `scene.js` exists.                                                                    |

Palette fields, per scheme, darkest-to-strongest in a dark scheme:

- **Surfaces**: `canvas` (the page), `sidebar`, `surface` (cards, bubbles), `raised` (floating layers), `hover`, `active`, `code` (code blocks).
- **Lines**: `border`, `borderStrong`.
- **Text**: `text` (primary), `muted` (secondary), `subtle` (quiet), `faint` (icons only, never words).
- **Accent**: `accent` (fills, marks), `accentHover`, `accentFg` (labels on an accent fill), `accentText` (links).
- **Diff**: `diffAdd` and `diffDel` fills with `diffAddFg` and `diffDelFg` text on them.
- **Syntax**: `syntax.kw`, `fn`, `str`, `num`, `type`, `com`, `punc`.
- **Glass**: `glass: { "blur": 0–64, "saturate": 100–300 }`, or `null` for solid floating layers.

Set the surfaces and text levels together, as one ramp: change `canvas` and leave the base's `text`, and the contrast check will usually fail.

## What a Suit can never change

Status colours (working, waiting on you, failed, done), row status colours, the approval strip, the Working line, the "waiting on you" markers and the danger fill stay ace's own in every Suit, so an agent's state always reads the same. Don't try to set them; extra keys are ignored. Your accent must also stay clearly apart from them (below).

## Checks

| Check         | Passes when                                                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`      | `suit.json` parses within the limits above.                                                                                                                                                                                                                                  |
| `contrast`    | `text`, `muted`, `subtle` and `accentText` reach 4.5:1 on every surface: `canvas`, `sidebar`, `surface`, `raised`, `code`, `hover`, `active`, a selected row, and glass. `faint` and `accent` reach 3:1 on `canvas`. `accentFg` reaches 4.5:1 on `accent` and `accentHover`. |
| `accent-fit`  | `accent` is not mistakable for a status colour: keep it away from the blue, amber, red, green, violet and pink ace uses for working, needs you, failed, done, waiting and unresponsive.                                                                                      |
| `glass-floor` | Text on glass still reads at 4.5:1 over frames sampled from your scene. A bright, busy scene needs darker glass (dark) or lighter glass (light).                                                                                                                             |
| `asset`       | Every `assets/` path exists, stays inside `assets/`, and fonts are files ace can load.                                                                                                                                                                                       |
| `scene`       | `scene.js` loads, calls `ace.scene` and draws a frame.                                                                                                                                                                                                                       |

### Reading problems

Each problem is `{ scheme, check, field, message }`. Fix the `field` in that `scheme`, change nothing else, then preview again. Typical fixes:

- `contrast` on `muted` or `subtle`: move that text colour away from the surfaces (darker in light, lighter in dark), or move the surfaces closer to `canvas`. One problem can name the worst surface; fixing it against that one usually fixes the rest.
- `contrast` on `accentText`: links need the same 4.5:1 as text. Take `accent` a step darker (light) or lighter (dark) for `accentText`.
- `contrast` on `accentFg`: pick white or near-black, whichever reads on `accent`.
- `accent-fit`: the gaps between status hues are narrow, so turn the accent's hue 20–40° toward the middle of one (bronze, warm orange and ice blue all fit) or lower its chroma; don't fight the check by nudging one digit.
- `glass-floor`: raise the scene's darkness behind the sidebar and transcript, or set `glass` to `null`.

## Scenes

`scene.js` is an animated backdrop behind the transcript and sidebar. Leave it out unless the look truly moves.

**The sandbox.** It runs in a sandboxed iframe with an opaque origin. It draws on one canvas (2D or WebGL) and can load images from its own `assets/`. It has no network, no storage, no access to ace's page and no thread contents, names or paths. `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `document.cookie`, `requestAnimationFrame` loops and `setInterval` animation all either fail or are not how frames come.

**The runtime.** Register once:

```js
ace.scene({
  init(view) {}, // view: { canvas, width, height, pixelRatio, scheme, reduceMotion }
  frame(time, view) {}, // draw one frame; time in ms, from ace's clock
  signal(name) {}, // "working", "waiting", "done", "failed" or "pr-merged"
  resize(view) {}, // new width, height or pixelRatio
  scheme(scheme) {}, // "light" or "dark"
});
```

ace owns the clock: it calls `frame` at 30 fps at most and stops calling it when the window is hidden, unfocused for a while or on battery saver. Under Reduce motion it calls `frame` once, and `view.reduceMotion` is `true`: draw one calm still frame there, never a flash. Signals are moods, not data: a short reaction (a pulse on `done`, a burst on `pr-merged`), never a lasting state, since ace's own markers already show state.

**Performance.**

- Allocate in `init` and `resize`; `frame` reuses arrays and objects and draws.
- Keep a frame well under 4 ms on a laptop: a few hundred simple shapes in 2D, or one full-screen shader pass. No per-pixel JavaScript loops, no blur or shadow filters per frame, no image decoding per frame.
- Size the canvas as `width × pixelRatio` by `height × pixelRatio`, capped at pixel ratio 2.
- Keep the backdrop low in contrast behind text; glass sits over it.
- A scene that throws, misses its frame budget three times or fails to load is stopped, and the Suit shows its colours alone. Test that it starts clean.

## Done when

`suit_apply` preview returned no problems, you looked at ace in each of the Suit's schemes, and the person chose keep or revert.
