// @vitest-environment jsdom
import { expect, test } from "vitest";
import { hintScript, pageHints, withHints, type HintChunk } from "./route-preloads.ts";

const chunk = (fileName: string, more: Partial<HintChunk> = {}): HintChunk => ({
  fileName,
  isEntry: false,
  facadeModuleId: null,
  imports: [],
  css: [],
  ...more,
});

const thread = "/app/src/routes/_home.t.$threadId.tsx?tsr-split=component";
const bundle = [
  chunk("assets/index.js", { isEntry: true, imports: ["assets/initial.js"] }),
  chunk("assets/initial.js", { imports: ["assets/runtime.js"] }),
  chunk("assets/runtime.js"),
  chunk("assets/thread.js", {
    facadeModuleId: thread,
    imports: ["assets/initial.js", "assets/view.js"],
    css: ["assets/thread.css"],
  }),
  chunk("assets/view.js", { imports: ["assets/runtime.js", "assets/shared.js"] }),
  chunk("assets/shared.js"),
  chunk("assets/settings.js", { facadeModuleId: "/app/src/routes/settings.tsx" }),
];
const routes = [{ path: "^/t/[^/]+/?$", modules: [thread] }];

test("the page preloads the entry's static closure, not the entry it already names", () => {
  expect(pageHints(bundle, routes).initial).toEqual(["assets/initial.js", "assets/runtime.js"]);
});

test("a route's hints are its chunks, their imports and CSS, minus what startup loads", () => {
  expect(pageHints(bundle, routes).routes).toEqual([
    {
      path: "^/t/[^/]+/?$",
      files: ["assets/thread.js", "assets/thread.css", "assets/view.js", "assets/shared.js"],
    },
  ]);
});

function linksAfterLoading(path: string): string[] {
  document.head.replaceChildren();
  const script = hintScript(pageHints(bundle, routes).routes, "/").replace(
    "location.pathname",
    JSON.stringify(path),
  );
  new Function(script)();
  return [...document.head.querySelectorAll("link")].map(
    (link) =>
      `${link.rel}${link.getAttribute("as") ? `:${link.getAttribute("as")}` : ""} ${link.getAttribute("href")}`,
  );
}

test("a page loaded at a thread's address starts that route's code at once", () => {
  expect(linksAfterLoading("/t/thread-1")).toEqual([
    "modulepreload /assets/thread.js",
    "preload:style /assets/thread.css",
    "modulepreload /assets/view.js",
    "modulepreload /assets/shared.js",
  ]);
});

test("a page loaded at another address hints nothing", () => {
  expect(linksAfterLoading("/settings")).toEqual([]);
  expect(linksAfterLoading("/t/thread-1/agents/a")).toEqual([]);
});

test("the hints go ahead of the entry script and its stylesheet, so no stylesheet holds them", () => {
  const html = `<head><style></style><script>theme()</script><script type="module" src="/assets/index.js"></script><link rel="stylesheet" href="/assets/initial.css"></head>`;
  const out = withHints(html, pageHints(bundle, routes), "/");
  const hints = out.indexOf('<link rel="modulepreload" crossorigin href="/assets/initial.js">');
  const route = out.indexOf("<script>(function (path, head)");
  expect(hints).toBeGreaterThan(out.indexOf("theme()"));
  expect(route).toBeGreaterThan(hints);
  expect(route).toBeLessThan(out.indexOf('<script type="module"'));
  expect(route).toBeLessThan(out.indexOf('<link rel="stylesheet"'));
});
