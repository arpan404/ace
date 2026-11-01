import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { chromium } from "@playwright/test";
import { inject, expect, test } from "vitest";

/*
 * Agent prose as the app draws it: the app's base styles (which reset lists, headings and rules
 * everywhere), the prose stylesheet (markit-ace.css) and markit's real renderer and worker, in
 * real Chromium. Answers lost their list markers once before; this keeps the look.
 */

const root = new URL("../../../", import.meta.url).pathname;
/** The base styles the web app ships (Tailwind's preflight), resolved where the app resolves it. */
const preflight = createRequire(join(root, "apps/web/package.json")).resolve(
  "tailwindcss/preflight.css",
);
const types: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};

const answer = [
  "## Wire flow",
  "",
  "1. Startup",
  "   - Daemon binds port",
  "   - Web connects",
  "2. Runtime",
  "",
  "- [x] Store append is atomic",
  "",
  "```mermaid",
  "graph LR",
  "  A --> B",
  "```",
  "",
  "See the note[^1] about issue #12 from @someone.",
  "",
  "[^1]: Footnotes render.",
  "",
  "<details>",
  "<summary>Appendix</summary>",
  "",
  "Hidden until opened.",
  "",
  "</details>",
].join("\n");

/** A page drawing `markdown` with markit into `#answer`, inside `wrapper`'s markup. */
const pageFor = (
  markdown: string,
  wrapper = '<div class="markit-ace"><div id="answer"></div></div>',
) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/preflight.css">
<link rel="stylesheet" href="/apps/web/src/components/markdown/markit-ace.css"></head>
<body>${wrapper}
<script type="module">
import { MarkitRenderer } from "/packages/markit/web/index.js";
const renderer = new MarkitRenderer(document.getElementById("answer"), {
  workerURL: "/apps/web/public/markit/worker.js",
  flavor: "agent",
  renderDiagram: (language) =>
    language === "mermaid" ? '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"></svg>' : null,
});
renderer.render(${JSON.stringify(markdown)}).then(
  () => setTimeout(() => { window.rendered = "ok"; }, 300),
  (error) => { window.rendered = String(error); },
);
</script></body></html>`;

/** Serves `page` at / and the repository's files beside it, for the test's lifetime. */
async function serve(page: string) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://host").pathname;
    if (path === "/") return response.writeHead(200, { "content-type": "text/html" }).end(page);
    const file = path === "/preflight.css" ? preflight : join(root, path);
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

test("agent prose keeps list markers, headings, details, footnotes and diagrams", async () => {
  const server = await serve(pageFor(answer));
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  try {
    const tab = await browser.newPage();
    await tab.goto(server.url);
    await tab.waitForFunction(() => Reflect.get(window, "rendered") !== undefined, null, {
      timeout: 15_000,
    });
    expect(await tab.evaluate(() => Reflect.get(window, "rendered"))).toBe("ok");
    const look = await tab.evaluate(() => {
      const computed = Object.fromEntries(
        [
          ["numbered", "ol > li"],
          ["bulleted", "ol ul > li"],
          ["list", "ol"],
          ["heading", "h2"],
        ].map(([name, selector]) => {
          const element = document.querySelector(selector ?? "");
          return [name, element ? getComputedStyle(element) : undefined];
        }),
      );
      return {
        numbered: computed.numbered?.listStyleType,
        bulleted: computed.bulleted?.listStyleType,
        indented: Number.parseFloat(computed.list?.paddingLeft ?? "0"),
        heading: computed.heading?.fontWeight,
        summary: document.querySelector("details > summary")?.textContent?.trim(),
        footnotes: document
          .querySelector(".mk-footnotes")
          ?.textContent?.includes("Footnotes render."),
        diagram: !!document.querySelector(".mk-diagram img"),
        forgeLinks: [...document.querySelectorAll("a, [role=link]")].some((link) =>
          /#12|@someone/.test(link.textContent ?? ""),
        ),
      };
    });
    expect(look).toEqual({
      numbered: "decimal",
      bulleted: "disc",
      indented: 20,
      heading: "600",
      summary: "Appendix",
      footnotes: true,
      diagram: true,
      forgeLinks: false,
    });
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);

const longUrl = `https://example.com/${"a".repeat(280)}`;
const bubbleMarkdown = [
  "## Repro",
  "",
  "- open the **checkout**",
  "- pay with `a-very-long-inline-code-identifier-that-goes-on-and-on-and-on`",
  "",
  "```ts",
  `const veryLongLine = ${JSON.stringify("x".repeat(200))};`,
  "```",
  "",
  "| column | another column | a third column | and a fourth one |",
  "| --- | --- | --- | --- |",
  "| value | value | value | value |",
  "",
  longUrl,
].join("\n");

/*
 * The person's bubble at a phone's width: the bubble keeps typed whitespace, as the app's does,
 * and draws its markdown with `ace-bubble-prose`. Overflow stays visible here, so anything wider
 * than the bubble would show up in the layout instead of being clipped.
 */
const bubble = `<div id="bubble" style="width:300px;padding:8px 12px;white-space:pre-wrap;overflow:visible">
<div class="markit-ace ace-bubble-prose"><div id="answer"></div></div></div>`;

test("markdown in a narrow bubble wraps long words and URLs and scrolls code and tables inside it", async () => {
  const server = await serve(pageFor(bubbleMarkdown, bubble));
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  try {
    const tab = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await tab.goto(server.url);
    await tab.waitForFunction(() => Reflect.get(window, "rendered") !== undefined, null, {
      timeout: 15_000,
    });
    expect(await tab.evaluate(() => Reflect.get(window, "rendered"))).toBe("ok");
    const layout = await tab.evaluate((url) => {
      const box = document.getElementById("bubble");
      if (!box) throw new Error("No bubble");
      const edge = box.getBoundingClientRect().right;
      // Elements inside a scroller may run past it; the scroller itself must fit.
      const insideScroller = (element: Element) => {
        for (let up = element.parentElement; up && up !== box; up = up.parentElement)
          if (["auto", "scroll"].includes(getComputedStyle(up).overflowX)) return true;
        return false;
      };
      const wider = [...box.querySelectorAll("*")]
        .filter((element) => !insideScroller(element))
        .filter((element) => element.getBoundingClientRect().right > edge + 0.5)
        .map((element) => element.tagName.toLowerCase() + "." + element.className);
      return {
        wider,
        pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        list: box.querySelectorAll("li").length,
        code: !!box.querySelector("pre code"),
        url: box.textContent?.includes(url) ?? false,
      };
    }, longUrl);
    expect(layout).toEqual({ wider: [], pageScrolls: false, list: 2, code: true, url: true });
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);
