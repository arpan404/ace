# Scenes

A scene is an animated backdrop for one region, drawn on one canvas. Add one only when the look truly moves (weather, a slow gradient drift, a starfield); a still background in `regions` or suit.css costs nothing and is always checkable.

## Files and regions

`scene.js` at the Suit's root is the app's scene. Other regions name their own file in `suit.json`'s `scenes`: `app`, `sidebar`, `header`, `composer`, `right-panel`, `page` (behind full pages). File names are letters, digits and dashes ending `.js`, at the root, up to 512 KB each. Every region's scene shares one clock and the same rules. How much of a scene shows is the region's `reveal` (or `--suit-<region>-scene-opacity` from suit.css), held under what keeps that region's text readable.

## The sandbox

Each scene runs in a sandboxed, opaque-origin iframe: no network, no storage, no access to ace's page, no thread contents, names or paths. It may load images from its own `assets/`. The canvas is made for you, fills the region and is sized to device pixels (pixel ratio capped at 2); draw with `canvas.getContext("2d")` or WebGL.

## The API

Register once; only `frame` is required.

```js
let ctx,
  stars,
  mood = 0,
  moodAt = -Infinity,
  now = 0;

ace.scene({
  init(view) {
    // view: { canvas, width, height, pixelRatio, scheme, reduceMotion }, kept current in place.
    ctx = view.canvas.getContext("2d");
    stars = Array.from({ length: 240 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random(),
    }));
  },
  frame(time, view) {
    now = time;
    const { width, height, pixelRatio } = view;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.fillStyle = view.scheme === "dark" ? "#07080c" : "#eef0f4";
    ctx.fillRect(0, 0, width, height);
    const drift = view.reduceMotion ? 0 : time * 0.00002;
    const lift = Math.max(0, 1 - (time - moodAt) / 1500) * mood;
    ctx.fillStyle = view.scheme === "dark" ? "rgba(220,226,240,0.5)" : "rgba(40,48,64,0.25)";
    for (const s of stars) {
      const x = ((s.x + drift * s.z) % 1) * width;
      ctx.fillRect(x, s.y * height, 1 + s.z + lift, 1 + s.z + lift);
    }
  },
  signal(name) {
    // "working", "waiting", "done", "failed" or "pr-merged": a mood, never state.
    mood = name === "done" || name === "pr-merged" ? 1 : 0;
    moodAt = now;
  },
  resize(view) {}, // new width, height or pixelRatio; the canvas is already resized
  scheme(scheme) {}, // "light" or "dark"; view.scheme is already updated
  motion(reduceMotion) {}, // Reduce motion turned on or off
});
```

- **ace owns the clock.** `frame(time, view)` arrives at most 30 times a second; `time` is ms of running scene time. Never call `requestAnimationFrame` or timers. Take "now" from the last `frame`'s `time`, never `performance.now()`.
- **Paused** when the window is hidden, blurred for 10 s, or the device saves power; it resumes where it stopped.
- **Reduce motion**: `frame` comes once with `view.reduceMotion` true. Draw the calm still frame that represents the look; a phone shows that frame too.
- **Signals** are a short reaction (a glint, a pulse that fades in a second or two). ace's own markers already show state, so the scene never has to.

## Budget

- Allocate in `init` and `resize`; `frame` reuses objects and only draws.
- Keep a frame well under 4 ms: a few hundred shapes in 2D or one shader pass. No per-pixel JavaScript loops, no per-frame `filter`, `shadowBlur` or image decoding.
- A scene that doesn't call `ace.scene` within 3 s, throws, or draws three frames in a row more than 100 ms late is stopped for good, and the Suit carries on with its colours and no scene.
- Keep it low in contrast and slow. Text sits on top; motion that pulls the eye away from the transcript is a bug in a premium Suit.

## Readability and the live check

The live check asks the scene's canvas for a small averaged grid (up to 32 × 32 cells) and composites each text part over the cells beneath it. It reads whatever the canvas shows at that moment, so a scene that is calm everywhere passes every time; one that flashes bright passes sometimes and fails sometimes.

- Draw shapes and gradients. A canvas that has drawn an image from `assets/` can't be read: the parts over it land in `live.unchecked`, and you must judge them from the screenshot.
- Keep the backdrop's brightness range narrow under text regions: dark scenes stay dark, light scenes stay light, in each scheme.
- If `live-contrast` fails over a scene, lower that region's `reveal` first, then dim the scene, before touching the palette.
- `glass-floor` failing means floating glass can't read over busy backdrops: set the scheme's `glass` to `null` or move `raised` and `text` further apart.
