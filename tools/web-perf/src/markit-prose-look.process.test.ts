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

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/preflight.css">
<link rel="stylesheet" href="/apps/web/src/components/markdown/markit-ace.css"></head>
<body><div class="markit-ace"><div id="answer"></div></div>
<script type="module">
import { MarkitRenderer } from "/packages/markit/web/index.js";
const renderer = new MarkitRenderer(document.getElementById("answer"), {
  workerURL: "/apps/web/public/markit/worker.js",
  flavor: "agent",
  renderDiagram: (language) =>
    language === "mermaid" ? '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"></svg>' : null,
});
renderer.render(${JSON.stringify(answer)}).then(
  () => setTimeout(() => { window.rendered = "ok"; }, 300),
  (error) => { window.rendered = String(error); },
);
</script></body></html>`;

test("agent prose keeps list markers, headings, details, footnotes and diagrams", async () => {
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
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${port}/`);
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
