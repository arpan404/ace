import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { sceneRuntimeScript } from "./index.ts";

interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  parentNode: unknown;
  setAttribute(name: string, value: string): void;
  getContext(kind: string): unknown;
}

/** A 2D context that takes every call and draws nothing. */
const silentContext: unknown = new Proxy(
  {},
  { get: () => () => ({ addColorStop() {} }), set: () => true },
);

/**
 * The sandbox page's globals, as far as the runtime reaches for them. `context` is every
 * canvas's 2D context, or a function making one per canvas.
 */
function sandbox(context: unknown = silentContext) {
  const replies: unknown[] = [];
  const host = { postMessage: (message: unknown) => replies.push(message) };
  const stranger = { postMessage: () => {} };
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const canvases: FakeCanvas[] = [];
  const placed: FakeCanvas[] = [];
  const body = {
    appendChild(node: FakeCanvas) {
      node.parentNode = body;
      placed.push(node);
    },
    removeChild(node: FakeCanvas) {
      node.parentNode = null;
      placed.splice(placed.indexOf(node), 1);
    },
  };
  const page: Record<string, unknown> = {
    parent: host,
    document: {
      body,
      documentElement: body,
      addEventListener() {},
      createElement() {
        const canvas: FakeCanvas = {
          width: 300,
          height: 150,
          style: {},
          parentNode: null,
          setAttribute() {},
          getContext: () =>
            typeof context === "function"
              ? (context as (on: FakeCanvas) => unknown)(canvas)
              : context,
        };
        canvases.push(canvas);
        return canvas;
      },
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  new Function("globalThis", sceneRuntimeScript)(page);
  const fire = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const ace = page["ace"] as { scene(definition: unknown): void };
  return {
    ace,
    replies,
    canvas: () => canvases[0],
    /** The canvases on the page, bottom first: the scene's, then any glass layers. */
    placed,
    send: (data: unknown, source: unknown = host) => fire("message", { source, data }),
    throwUncaught: (error: Error) => fire("error", { error, message: error.message }),
    stranger,
  };
}

const init = {
  type: "init",
  scheme: "dark",
  width: 800,
  height: 600,
  pixelRatio: 2,
  reduceMotion: false,
};

test("a scene is ready once it is defined and the host has sent init, in either order", () => {
  const early = sandbox();
  early.ace.scene({ frame() {} });
  expect(early.replies).toEqual([]);
  early.send(init);
  expect(early.replies).toEqual([{ type: "ready" }]);

  const late = sandbox();
  late.send(init);
  expect(late.replies).toEqual([]);
  late.ace.scene({ frame() {} });
  expect(late.replies).toEqual([{ type: "ready" }]);
});

test("init hands the scene a view: its canvas sized in device pixels and the host's facts", () => {
  const page = sandbox();
  let seen: unknown;
  page.ace.scene({
    init: (view: unknown) => (seen = { ...(view as object) }),
    frame() {},
  });
  page.send(init);
  expect(seen).toEqual({
    canvas: page.canvas(),
    width: 800,
    height: 600,
    pixelRatio: 2,
    scheme: "dark",
    reduceMotion: false,
    region: "app",
  });
  expect(page.canvas()).toMatchObject({ width: 1600, height: 1200 });
});

/** The region a scene's view names after the host's `init`. */
function regionOf(message: object) {
  const page = sandbox();
  let region: unknown;
  page.ace.scene({ init: (view: { region: unknown }) => (region = view.region), frame() {} });
  page.send(message);
  return region;
}

test("the view names the region the host runs the frame in, so one file can serve several", () => {
  expect(regionOf({ ...init, region: "celebration" })).toBe("celebration");
  expect(regionOf(init)).toBe("app");
  expect(regionOf({ ...init, region: "<script>" })).toBe("app");
});

test("a celebration says once that it has played out, and only after it started", () => {
  const page = sandbox();
  page.ace.scene({ frame() {} });
  (page.ace as unknown as { finish(): void }).finish();
  expect(page.replies).toEqual([]);
  page.send({ ...init, region: "celebration" });
  const ace = page.ace as unknown as { finish(): void };
  ace.finish();
  ace.finish();
  expect(page.replies).toEqual([{ type: "ready" }, { type: "finished" }]);
});

test("each tick draws one frame and answers drawn with the tick's time", () => {
  const page = sandbox();
  const frames: number[] = [];
  page.ace.scene({ frame: (time: number) => frames.push(time) });
  page.send(init);
  page.send({ type: "tick", time: 33 });
  page.send({ type: "tick", time: 66 });
  expect(frames).toEqual([33, 66]);
  expect(page.replies).toEqual([
    { type: "ready" },
    { type: "drawn", time: 33 },
    { type: "drawn", time: 66 },
  ]);
});

test("a frame that returns a promise answers drawn when it settles", async () => {
  const page = sandbox();
  page.ace.scene({ frame: () => Promise.resolve() });
  page.send(init);
  page.send({ type: "tick", time: 10 });
  expect(page.replies).toEqual([{ type: "ready" }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(page.replies).toEqual([{ type: "ready" }, { type: "drawn", time: 10 }]);
});

test("signals, scheme and size reach the scene; resize resizes the canvas", () => {
  const page = sandbox();
  const heard: unknown[] = [];
  page.ace.scene({
    frame() {},
    signal: (name: string) => heard.push(["signal", name]),
    scheme: (scheme: string) => heard.push(["scheme", scheme]),
    resize: (view: { width: number; height: number }) =>
      heard.push(["resize", view.width, view.height]),
  });
  page.send(init);
  page.send({ type: "signal", signal: "pr-merged" });
  page.send({ type: "scheme", scheme: "light" });
  page.send({ type: "resize", width: 400, height: 300, pixelRatio: 1 });
  expect(heard).toEqual([
    ["signal", "pr-merged"],
    ["scheme", "light"],
    ["resize", 400, 300],
  ]);
  expect(page.canvas()).toMatchObject({ width: 400, height: 300 });
});

test("messages from anything but the host frame are ignored", () => {
  const page = sandbox();
  const frames: number[] = [];
  page.ace.scene({ frame: (time: number) => frames.push(time) });
  page.send(init, page.stranger);
  page.send(init);
  page.send({ type: "tick", time: 1 }, page.stranger);
  expect(frames).toEqual([]);
  expect(page.replies).toEqual([{ type: "ready" }]);
});

test("a scene that throws reports one error and draws nothing more", () => {
  const page = sandbox();
  let calls = 0;
  page.ace.scene({
    frame() {
      calls += 1;
      throw new Error("shader failed to compile");
    },
  });
  page.send(init);
  page.send({ type: "tick", time: 1 });
  page.send({ type: "tick", time: 2 });
  expect(calls).toBe(1);
  expect(page.replies).toEqual([
    { type: "ready" },
    { type: "error", message: "shader failed to compile" },
  ]);
});

test("an uncaught error in the page is reported, cut to 500 characters", () => {
  const page = sandbox();
  page.throwUncaught(new Error("x".repeat(900)));
  expect(page.replies).toEqual([{ type: "error", message: "x".repeat(500) }]);
});

test("a definition without frame, or a second definition, is an error", () => {
  const missing = sandbox();
  missing.ace.scene({});
  expect(missing.replies).toEqual([
    { type: "error", message: "ace.scene needs an object with a frame(time) function" },
  ]);
  const twice = sandbox();
  twice.ace.scene({ frame() {} });
  twice.ace.scene({ frame() {} });
  expect(twice.replies).toEqual([
    { type: "error", message: "ace.scene was called more than once" },
  ]);
});

test("a sample answers with the canvas averaged to the asked grid, once the scene has started", () => {
  const drawn: unknown[][] = [];
  const reader = {
    drawImage: (...args: unknown[]) => drawn.push(args),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(40),
    }),
  };
  const page = sandbox(reader);
  page.send({ type: "sample", id: 1, columns: 2, rows: 1 });
  expect(page.replies).toEqual([]);
  page.ace.scene({ frame() {} });
  page.send(init);
  page.send({ type: "sample", id: 2, columns: 2, rows: 1 });
  page.send({ type: "sample", id: 3, columns: 99, rows: 1 });
  expect(page.replies).toEqual([
    { type: "ready" },
    { type: "sample", id: 2, columns: 2, rows: 1, pixels: [40, 40, 40, 40, 40, 40, 40, 40] },
  ]);
  // The scene's own canvas, scaled into the grid.
  expect(drawn).toEqual([[page.canvas(), 0, 0, 2, 1]]);
});

test("a canvas the runtime can't read (tainted by an image) answers no sample and no error", () => {
  const page = sandbox({
    drawImage() {},
    getImageData() {
      throw new Error("The canvas has been tainted by cross-origin data.");
    },
  });
  page.ace.scene({ frame() {} });
  page.send(init);
  page.send({ type: "sample", id: 1, columns: 4, rows: 4 });
  page.send({ type: "tick", time: 0 });
  expect(page.replies).toEqual([{ type: "ready" }, { type: "drawn", time: 0 }]);
});

/** An offscreen canvas for scenes that paint layers once and blit them. */
const offscreenDocument = {
  createElement: () => ({ width: 0, height: 0, getContext: () => silentContext }),
};

test.each([
  "arcade-cabinet",
  "atelier-noir",
  "atelier-noir/celebration",
  "field-journal",
  "field-journal/celebration",
  "quest-journal",
  "quest-journal/celebration",
])(
  "the shipped %s scene starts clean, reacts to every signal and draws under the runtime",
  (id) => {
    const source = readFileSync(
      new URL(
        `../../plugins/builtin-suits/${id.includes("/") ? id : `${id}/scene`}.js`,
        import.meta.url,
      ),
      "utf8",
    );
    const page = sandbox();
    new Function("ace", "document", "OffscreenCanvas", source)(
      page.ace,
      offscreenDocument,
      undefined,
    );
    page.send(init);
    page.send({ type: "tick", time: 0 });
    for (const signal of ["working", "waiting", "failed", "pr-merged", "done"])
      page.send({ type: "signal", signal });
    page.send({ type: "tick", time: 33 });
    page.send({ type: "resize", width: 400, height: 300, pixelRatio: 1 });
    page.send({ type: "tick", time: 66 });
    page.send({ type: "motion", reduceMotion: true });
    page.send({ type: "tick", time: 99 });
    // A celebration may say it's finished once motion is turned off; that is covered below.
    expect(page.replies.filter((reply) => (reply as { type: string }).type !== "finished")).toEqual(
      [
        { type: "ready" },
        { type: "drawn", time: 0 },
        { type: "drawn", time: 33 },
        { type: "drawn", time: 66 },
        { type: "drawn", time: 99 },
      ],
    );
  },
);

test.each([
  ["arcade-cabinet/stage-clear", "pr-merged"],
  ["atelier-noir/celebration", "pr-merged"],
  ["field-journal/celebration", "done"],
  ["quest-journal/celebration", "done"],
])(
  "the shipped %s celebration plays once on %s, then says it's done well before ace's 4 s cut",
  (file, signal) => {
    const source = readFileSync(
      new URL(`../../plugins/builtin-suits/${file}.js`, import.meta.url),
      "utf8",
    );
    const page = sandbox();
    new Function("ace", "document", source)(page.ace, offscreenDocument);
    page.send({ ...init, region: "celebration" });
    // The clock is shared with the app's scenes, so the moment may start far from zero.
    for (let time = 50_000; time <= 50_066; time += 33) page.send({ type: "tick", time });
    expect(page.replies.some((reply) => (reply as { type: string }).type === "finished")).toBe(
      false,
    );
    page.send({ type: "signal", signal });
    let finishedAt = -1;
    for (let time = 50_099; time <= 54_200; time += 33) {
      const before = page.replies.length;
      page.send({ type: "tick", time });
      const answered = page.replies.slice(before) as { type: string }[];
      if (finishedAt < 0 && answered.some((reply) => reply.type === "finished")) finishedAt = time;
    }
    const replies = page.replies as { type: string }[];
    expect(replies[0]).toEqual({ type: "ready" });
    expect(replies.filter((reply) => reply.type === "finished")).toEqual([{ type: "finished" }]);
    expect(replies.some((reply) => reply.type === "error")).toBe(false);
    expect(finishedAt - 50_099).toBeGreaterThan(2500);
    expect(finishedAt - 50_099).toBeLessThan(3900);
  },
);

/*
 * Glass. Node has no canvas, so `painter` stands in for a 2D context with just enough of a model
 * to say what a canvas shows: what was drawn on it since it was last cleared, and through which
 * filter. Where a glass layer shows is its `clip-path`, read back here as boxes.
 */
function painter(options: { failOn?: unknown } = {}) {
  const painted = new Map<unknown, { source: unknown; filter: string }[]>();
  const make = (canvas: unknown) => {
    let filter = "none";
    return {
      set filter(value: string) {
        filter = value;
      },
      get filter() {
        return filter;
      },
      clearRect: () => painted.set(canvas, []),
      drawImage: (source: unknown) => {
        if (options.failOn !== undefined && source === options.failOn) throw new Error("lost");
        painted.set(canvas, [...(painted.get(canvas) ?? []), { source, filter }]);
      },
    };
  };
  return { make, on: (canvas: unknown) => painted.get(canvas) ?? [] };
}

/** The boxes a `clip-path: path(...)` of closed shapes covers, one per shape. */
function clipBoxes(clipPath: string | undefined) {
  const path = /^path\('(.*)'\)$/.exec(clipPath ?? "")?.[1] ?? "";
  return path
    .split("M")
    .filter(Boolean)
    .map((shape) => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [, command, args] of shape.matchAll(/([A-Z]?)([^A-Z]*)/g)) {
        const n = (args ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
        if (n.length === 0) continue;
        if (command === "" || command === "A") {
          xs.push(n.at(-2) ?? 0);
          ys.push(n.at(-1) ?? 0);
        } else if (command === "H") xs.push(n[0] ?? 0);
        else if (command === "V") ys.push(n[0] ?? 0);
      }
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    });
}

const pane = { x: 10, y: 20, width: 100, height: 50, radius: 8, blur: 16, saturate: 1.5 };
const box = (rect: typeof pane) => ({
  x: rect.x,
  y: rect.y,
  width: rect.width,
  height: rect.height,
});
const layers = (page: ReturnType<typeof sandbox>) => page.placed.slice(1);

test("after each frame, glass shows the scene blurred inside its rectangles, over the scene", () => {
  const paint = painter();
  const page = sandbox(paint.make);
  page.ace.scene({ frame() {} });
  page.send(init);
  page.send({ type: "glass", rects: [pane] });
  page.send({ type: "tick", time: 0 });

  const [scene, layer] = page.placed;
  expect(scene).toBe(page.canvas());
  // A quarter-size copy of the scene's own canvas through the pane's blur, scaled to match.
  expect(layer).toMatchObject({ width: 200, height: 150 });
  expect(paint.on(layer)).toEqual([{ source: scene, filter: "blur(4px) saturate(1.5)" }]);
  expect(clipBoxes(layer?.style["clipPath"])).toEqual([box(pane)]);
  expect(page.replies).toEqual([{ type: "ready" }, { type: "drawn", time: 0 }]);
});

test("panes with different blurs get their own layer; an empty list takes the glass away", () => {
  const paint = painter();
  const page = sandbox(paint.make);
  page.ace.scene({ frame() {} });
  page.send(init);
  const soft = { ...pane, x: 300, blur: 32, saturate: 1 };
  const lower = { ...pane, y: 200 };
  page.send({ type: "glass", rects: [pane, soft, lower] });
  page.send({ type: "tick", time: 0 });
  expect(
    layers(page).map((layer) => ({
      clip: clipBoxes(layer.style["clipPath"]),
      filter: paint.on(layer)[0]?.filter,
      width: layer.width,
    })),
  ).toEqual([
    { clip: [box(pane), box(lower)], filter: "blur(4px) saturate(1.5)", width: 200 },
    { clip: [box(soft)], filter: "blur(4px) saturate(1)", width: 100 },
  ]);

  page.send({ type: "glass", rects: [] });
  expect(layers(page)).toEqual([]);
});

test("moved rectangles take effect at once, without waiting for a frame", () => {
  const page = sandbox(painter().make);
  page.ace.scene({ frame() {} });
  page.send(init);
  page.send({ type: "glass", rects: [pane] });
  page.send({ type: "tick", time: 0 });
  const moved = { ...pane, x: 400, radius: 0 };
  page.send({ type: "glass", rects: [moved] });
  expect(layers(page).map((layer) => clipBoxes(layer.style["clipPath"]))).toEqual([[box(moved)]]);
});

test("glass sent before the scene starts shows on its first frame", () => {
  const paint = painter();
  const page = sandbox(paint.make);
  page.send({ type: "glass", rects: [pane] });
  page.ace.scene({ frame() {} });
  page.send(init);
  page.send({ type: "tick", time: 0 });
  const [layer] = layers(page);
  expect(paint.on(layer)).toEqual([{ source: page.canvas(), filter: "blur(4px) saturate(1.5)" }]);
});

test("a malformed glass message is ignored and the last good glass stays", () => {
  const page = sandbox(painter().make);
  page.ace.scene({ frame() {} });
  page.send(init);
  page.send({ type: "glass", rects: [pane] });
  page.send({ type: "glass", rects: [{ ...pane, width: Number.NaN }] });
  page.send({ type: "glass", rects: Array.from({ length: 33 }, () => pane) });
  page.send({ type: "glass", rects: "everything" });
  page.send({ type: "tick", time: 0 });
  expect(layers(page).map((layer) => clipBoxes(layer.style["clipPath"]))).toEqual([[box(pane)]]);
  expect(page.replies).toEqual([{ type: "ready" }, { type: "drawn", time: 0 }]);
});

test("glass that fails to draw takes itself away; the scene keeps drawing and reports no error", () => {
  const holder: { scene?: unknown } = {};
  const paint = painter({
    get failOn() {
      return holder.scene;
    },
  });
  const page = sandbox(paint.make);
  holder.scene = page.canvas();
  page.ace.scene({ frame() {} });
  page.send(init);
  page.send({ type: "glass", rects: [pane] });
  page.send({ type: "tick", time: 0 });
  page.send({ type: "tick", time: 33 });
  expect(layers(page)).toEqual([]);
  expect(page.replies).toEqual([
    { type: "ready" },
    { type: "drawn", time: 0 },
    { type: "drawn", time: 33 },
  ]);
});
