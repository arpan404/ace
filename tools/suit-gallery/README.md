# Suit scene gallery

A place to judge Suit scenes in motion before any Suit is built around one. Not shipped.

```sh
bun tools/suit-gallery/src/serve.ts
```

Then open <http://127.0.0.1:4870/>. Pass `--port <n>` to use another port.

## What it shows

Each scene fills the window behind a still mock of ace as frosted glass: rail, sidebar with thread
rows and status icons, a transcript with a work log, live pill and composer. The glass tint,
edges, ink and accent come from the scene's `palette.json`.

The bar across the top:

- the six scenes (keys `1` to `6`);
- the signals `working`, `waiting`, `done`, `failed` and `pr-merged`, sent as ace sends them;
- Reduce motion: the scene draws its one still frame;
- Hide UI: the scene alone.

`?scene=<name>` opens a scene directly, and `&reduce=1` opens it still. From the console,
`gallery.signal("pr-merged")`, `gallery.load("nebula")`, `gallery.hide(true)`,
`gallery.state()` and `gallery.contrast()` drive it.

## Glass and text contrast

`gallery.contrast()` reads the live scene through the runtime's own `sample` message (a 32 × 32
grid of the canvas) and, for every text element in the mock, composites what is under it the way
the browser draws it: the scene blurred by the glass's blur and saturated, the glass tint, any
fills between, then the text colour with its alpha. It returns the worst WCAG ratio per text and
shows the least in the bar. Each scene's `palette.json` sets the lightest glass that keeps every
text at 4.5:1 or better, at rest and at the peak of `pr-merged`, so the scene shows as much as it
can.

## How a scene runs here

Every scene is one `scenes/<name>/scene.js` written for `ace.scene` (ADR 0150, and the
make-a-suit skill's `references/scenes.md`). The server gives it the same page, runtime
(`sceneRuntimeScript` from `@ace/suit-scene-runtime`), CSP and sandbox the daemon gives a Suit's
scene, and `page/gallery.js` plays ace's host: `init`, at most 30 ticks a second, signals,
Reduce motion and resize. A scene that works here can be copied into a Suit folder as its
`scene.js` unchanged.

All six are WebGL 2 fragment shaders: one full-window triangle, drawn at reduced resolution and
scaled up by the browser.

## Frame time

<http://127.0.0.1:4870/bench.html> draws each scene at 1440 × 900, pixel ratio 2, and times every
frame up to a 1-pixel `readPixels`, which waits for the GPU to finish it. Read the frame+sync
column. The timer-query column reads high on macOS and is there for reference only.
