# Scenes

A scene is an animated backdrop for one region, drawn on one canvas. Add one only when the look truly moves (weather, a slow gradient drift, drifting particles); a still background in `regions` or suit.css costs nothing and is always checkable.

## Files and regions

`scene.js` at the Suit's root is the app's scene. Other regions name their own file in `suit.json`'s `scenes`: `app`, `sidebar`, `header`, `composer`, `right-panel`, `page` (behind full pages), and `celebration` (above everything, for a moment; see "Celebration"). File names are letters, digits and dashes ending `.js`, at the root, up to 512 KB each. Every region's scene shares one clock and the same rules. How much of a scene shows is the region's `reveal` (or `--suit-<region>-scene-opacity` from suit.css), held under what keeps that region's text readable.

## Celebration

`scenes.celebration` is not a backdrop: it is a moment ace plays ABOVE the whole UI, so a Suit can mark a win the way its look would ("STAGE CLEAR!", a stamp, a burst of petals) at full strength instead of a ghost behind the transcript.

- **When.** Only when the open thread's run finishes (`done`) or one of the person's linked pull requests merges (`pr-merged`). At most once every 10 s, never on a hidden window, never under Reduce motion (there is no still frame of a celebration: it simply doesn't play).
- **How long.** ace takes the frame down after 4 s at the latest. Play for about 3 s, fade out, then call `ace.finish()` so ace takes it down at once.
- **What it hears.** `init` (with `view.region === "celebration"`), then right away `signal(name)` with what woke it; no other signals. Start the animation from that signal, timed by `frame`'s `time`.
- **Transparent.** The frame is clear wherever you draw nothing: create the context with alpha (`getContext("2d")`, never `{ alpha: false }`), `clearRect` every frame, and draw only the effect. Never fill the window.
- **Out of the way.** The pointer passes through it. ace cuts a hole in it around the approval strip, the Working line, question cards and status icons (plus a few pixels), measured while it plays, so they are never covered whatever you draw; don't try to avoid them yourself.
- **The same file twice.** One file may serve the app's backdrop and the celebration: branch on `view.region`.

```js
let ctx,
  startedAt = -1,
  now = 0,
  done = false;
ace.scene({
  init(view) {
    ctx = view.canvas.getContext("2d");
  },
  signal(name) {
    startedAt = now;
  }, // "done" or "pr-merged"
  frame(time, view) {
    now = time;
    if (startedAt < 0 || done) return;
    const t = (time - startedAt) / 3000;
    ctx.setTransform(view.pixelRatio, 0, 0, view.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    if (t >= 1) {
      done = true;
      ace.finish();
      return;
    }
    ctx.globalAlpha = t > 0.8 ? (1 - t) / 0.2 : 1;
    // … draw the burst …
  },
});
```

Arcade Cabinet's `stage-clear.js` is a complete one.

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
    // view: { canvas, width, height, pixelRatio, scheme, reduceMotion, region }, kept current.
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
- **Glass is ace's.** Where ace's glass (sidebar, panels, composer, menus) sits over the scene, the runtime draws your canvas blurred inside it after every frame; don't blur anything yourself. With WebGL, create the context with `preserveDrawingBuffer: true`, so the glass and the live check can read your last frame between ticks.
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
