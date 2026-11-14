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

/** The sandbox page's globals, as far as the runtime reaches for them. */
function sandbox() {
  const replies: unknown[] = [];
  const host = { postMessage: (message: unknown) => replies.push(message) };
  const stranger = { postMessage: () => {} };
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const canvases: FakeCanvas[] = [];
  const body = {
    appendChild(node: FakeCanvas) {
      node.parentNode = body;
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
          getContext: () => silentContext,
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
  });
  expect(page.canvas()).toMatchObject({ width: 1600, height: 1200 });
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

test("the shipped Starfield scene starts clean and draws under the runtime", () => {
  const source = readFileSync(
    new URL("../../plugins/builtin-suits/starfield/scene.js", import.meta.url),
    "utf8",
  );
  const page = sandbox();
  new Function("ace", source)(page.ace);
  page.send(init);
  page.send({ type: "tick", time: 0 });
  page.send({ type: "signal", signal: "pr-merged" });
  page.send({ type: "tick", time: 33 });
  page.send({ type: "resize", width: 400, height: 300, pixelRatio: 1 });
  page.send({ type: "tick", time: 66 });
  expect(page.replies).toEqual([
    { type: "ready" },
    { type: "drawn", time: 0 },
    { type: "drawn", time: 33 },
    { type: "drawn", time: 66 },
  ]);
});
