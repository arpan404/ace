import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "@playwright/test";
import { contentSecurityPolicy } from "@ace/html/app-policy";
import { inject, expect, test } from "vitest";

/*
 * The desktop app sends its Content Security Policy as a header on every response, so markit's
 * worker runs under it too. Without permission to compile WebAssembly, the worker never starts
 * and every agent answer renders blank. This serves the built worker (apps/web/public/markit,
 * made by the postinstall) under the app's own policy and renders a message through it.
 */

const assets = new URL("../../../apps/web/public/", import.meta.url).pathname;
const types: Record<string, string> = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};
const page = `<!doctype html><script type="module" src="/main.js"></script>`;
const main = `const worker = new Worker('/markit/worker.js', { type: 'module' });
worker.onmessage = (event) => { window.rendered = event.data.error ? 'error: ' + event.data.error : event.data.result.blocks.length; };
worker.onerror = (event) => { window.rendered = 'worker error: ' + event.message; };
worker.postMessage({ id: 1, type: 'render', stream: 1, source: '# Done\\n\\nAll **merged** branches deleted.', finalized: true });`;

test("markit's worker renders a message under the app's content security policy", async () => {
  const policy = contentSecurityPolicy({});
  const server = createServer((request, response) => {
    const headers = { "Content-Security-Policy": policy };
    const path = request.url ?? "/";
    if (path === "/")
      return response.writeHead(200, { ...headers, "content-type": "text/html" }).end(page);
    if (path === "/main.js")
      return response.writeHead(200, { ...headers, "content-type": "text/javascript" }).end(main);
    try {
      const body = readFileSync(join(assets, path));
      const type = types[extname(path)] ?? "application/octet-stream";
      response.writeHead(200, { ...headers, "content-type": type }).end(body);
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
    expect(await tab.evaluate(() => Reflect.get(window, "rendered"))).toBe(2);
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);
