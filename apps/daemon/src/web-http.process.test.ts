import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { webHttp } from "./web-http.ts";

let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  if (root) await rm(root, { recursive: true, force: true });
});

async function serve(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "ace-web-http-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
  server = createServer(
    webHttp(root, (_request, response) => {
      response.statusCode = 418;
      response.end();
    }),
  );
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

test("the web app's icons are served from the renderer root with image types", async () => {
  const origin = await serve({
    "index.html": "<!doctype html>",
    "favicon.svg": "<svg/>",
    "favicon.png": "png bytes",
    "apple-touch-icon.png": "touch bytes",
  });
  const touch = await fetch(`${origin}/apple-touch-icon.png`);
  expect(touch.headers.get("content-type")).toBe("image/png");
  expect(await touch.text()).toBe("touch bytes");
  const png = await fetch(`${origin}/favicon.png`);
  expect(await png.text()).toBe("png bytes");
  const svg = await fetch(`${origin}/favicon.svg`);
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
});

test("other root files are not exposed; the page is served in their place", async () => {
  const origin = await serve({ "index.html": "<!doctype html>", "secret.png": "private" });
  const response = await fetch(`${origin}/secret.png`);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toBe("<!doctype html>");
});
