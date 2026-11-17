/*
 * Suit scenes for the `this` and frame-alias tests (ADR 0173 §8): each `blocked` sample reaches
 * another frame or the network through a `this` the check can't prove (a function a timer or a
 * listener runs, where `this` is the global object) or through an alias or built name of a frame
 * member. The `benign` samples only draw. Inert data: nothing here is run, and every host is under
 * `.invalid`.
 */

import type { SceneSample } from "./corpus-r2-scene.ts";

const suitJson = JSON.stringify({ format: 1, id: "sample", name: "Sample", version: "1" });

const scene = (id: string, code: string): SceneSample => ({
  id,
  files: { "suit.json": suitJson, "scene.js": code },
});

export const blockedThisScenes: readonly SceneSample[] = [
  scene(
    "timer-this-parent-post",
    `ace.scene({ init() { setTimeout(function () { this.parent.postMessage("x", "*"); }, 0); }, frame() {} });\n`,
  ),
  scene(
    "callback-this-fetch",
    `ace.scene({ init(view) { view.canvas.addEventListener("click", function () { this.fetch("https://x.invalid/p"); }); }, frame() {} });\n`,
  ),
  scene("method-this-fetch", `ace.scene({ frame() { this.fetch("https://x.invalid/p"); } });\n`),
  scene(
    "window-alias-top",
    `ace.scene({ init() { const w = window; w.top.location; }, frame() {} });\n`,
  ),
  scene(
    "this-post-message-alias",
    `ace.scene({ init() { setTimeout(function () { const send = this.postMessage; send("x", "*"); }, 0); }, frame() {} });\n`,
  ),
  scene(
    "this-computed-parent",
    `ace.scene({ init() { setTimeout(function () { this["pa" + "rent"].focus(); }, 0); }, frame() {} });\n`,
  ),
  scene(
    "this-alias-self",
    `ace.scene({ init() { setTimeout(function () { const g = this; g.opener; }, 0); }, frame() {} });\n`,
  ),
  scene(
    "class-method-this-parent",
    `class Ticker { tick() { this.parent; } }\nconst t = new Ticker();\nace.scene({ init() { setTimeout(t.tick, 0); }, frame() {} });\n`,
  ),
  scene("local-object-frames", `const box = { w: 1 };\nace.scene({ frame() { box.frames; } });\n`),
  scene(
    "event-view-parent",
    `ace.scene({ init(view) { view.canvas.addEventListener("click", (e) => { e.view.parent.focus(); }); }, frame() {} });\n`,
  ),
];

export const benignThisScenes: readonly SceneSample[] = [
  scene(
    "plain-draw",
    `ace.scene({\n  frame(time, ctx) {\n    ctx.clearRect(0, 0, 100, 100);\n    ctx.textBaseline = "top";\n    ctx.fillRect(Math.sin(time / 1000) * 50 + 50, 10, 4, 4);\n    requestAnimationFrame(() => {});\n  },\n});\n`,
  ),
  scene(
    "timer-draws-captured-ctx",
    `ace.scene({\n  init(ctx) {\n    setTimeout(function () {\n      ctx.fillStyle = "#123456";\n      ctx.fillRect(0, 0, 10, 10);\n    }, 16);\n  },\n  frame() {},\n});\n`,
  ),
  scene(
    "class-constructor-this",
    `class Dot {\n  x = 0;\n  constructor(y) {\n    this.y = y;\n    this.step = () => { this.x += 1; };\n  }\n}\nconst dot = new Dot(2);\nace.scene({ frame(time, ctx) { dot.step(); ctx.fillRect(dot.x, dot.y, 1, 1); } });\n`,
  ),
  scene(
    "own-data-top",
    `const outfit = { top: "#aa3344", bottom: "#223344" };\nace.scene({ frame(time, ctx) { ctx.fillStyle = outfit.top; ctx.fillRect(0, 0, 4, 4); } });\n`,
  ),
];
