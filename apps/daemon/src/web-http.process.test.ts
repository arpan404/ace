import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { webHttp } from "./web-http.ts";

type Fetched = { status: number; headers: IncomingHttpHeaders; body: Buffer };

function fetchRaw(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.on("end", () =>
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks),
        }),
      );
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function serveRenderer(onTestFinished: (finisher: () => Promise<void>) => void): Promise<{
  port: number;
  root: string;
  html: string;
  script: string;
  font: Buffer;
  tiny: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ace-web-"));
  const html = `<html><body>${"hello ace ".repeat(400)}</body></html>`;
  const script = `console.log("ace");\n${"// filler to exceed one kibibyte\n".repeat(80)}`;
  const tiny = `console.log("tiny");\n`;
  const font = Buffer.alloc(2048, 7);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), html);
  await writeFile(join(root, "assets", "app.js"), script);
  await writeFile(join(root, "assets", "tiny.js"), tiny);
  await writeFile(join(root, "assets", "font.woff2"), font);
  const server: Server = createServer(
    webHttp(root, (_request, response) => {
      response.statusCode = 404;
      response.end("next");
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  });
  return { port, root, html, script, font, tiny };
}

test("a browser accepting brotli receives the exact renderer bytes", async ({ onTestFinished }) => {
  const { port, html } = await serveRenderer(onTestFinished);
  const response = await fetchRaw(port, "/", { "accept-encoding": "br, gzip" });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers.vary).toBe("Accept-Encoding");
  expect(response.headers["content-type"]).toContain("text/html");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(Number(response.headers["content-length"])).toBe(response.body.length);
  expect(brotliDecompressSync(response.body).toString("utf8")).toBe(html);
});

test("a browser accepting only gzip receives a gzip body matching the file", async ({
  onTestFinished,
}) => {
  const { port, script } = await serveRenderer(onTestFinished);
  const response = await fetchRaw(port, "/assets/app.js", { "accept-encoding": "gzip" });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBe("gzip");
  expect(response.headers.vary).toBe("Accept-Encoding");
  expect(gunzipSync(response.body).toString("utf8")).toBe(script);
});

test("built assets are cached for good while the page and icons are always fetched again", async ({
  onTestFinished,
}) => {
  const { port, root } = await serveRenderer(onTestFinished);
  await writeFile(join(root, "favicon.svg"), "<svg/>");
  const script = await fetchRaw(port, "/assets/app.js");
  expect(script.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  const page = await fetchRaw(port, "/t/some-thread");
  expect(page.headers["cache-control"]).toBe("no-store");
  const icon = await fetchRaw(port, "/favicon.svg");
  expect(icon.headers["cache-control"]).toBe("no-store");
  const missing = await fetchRaw(port, "/assets/missing-0123.js");
  expect(missing.status).toBe(404);
  expect(missing.headers["cache-control"]).toBeUndefined();
});

test("a browser sending no accept-encoding receives the raw bytes", async ({ onTestFinished }) => {
  const { port, script } = await serveRenderer(onTestFinished);
  const response = await fetchRaw(port, "/assets/app.js");
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers.vary).toBe("Accept-Encoding");
  expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(script));
  expect(response.body.toString("utf8")).toBe(script);
});

test("a browser refusing every coding receives the raw bytes", async ({ onTestFinished }) => {
  const { port, script } = await serveRenderer(onTestFinished);
  const response = await fetchRaw(port, "/assets/app.js", {
    "accept-encoding": "br;q=0, gzip;q=0",
  });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.body.toString("utf8")).toBe(script);
});

test("a font is never compressed even when the browser accepts brotli", async ({
  onTestFinished,
}) => {
  const { port, font } = await serveRenderer(onTestFinished);
  const response = await fetchRaw(port, "/assets/font.woff2", {
    "accept-encoding": "br, gzip",
  });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers["content-type"]).toBe("font/woff2");
  expect(response.body.equals(font)).toBe(true);
});

test("a tiny script is sent raw even when the browser accepts brotli", async ({
  onTestFinished,
}) => {
  const { port, tiny } = await serveRenderer(onTestFinished);
  const response = await fetchRaw(port, "/assets/tiny.js", { "accept-encoding": "br" });
  expect(response.status).toBe(200);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.body.toString("utf8")).toBe(tiny);
});

test("a HEAD response reports the compressed length without sending a body", async ({
  onTestFinished,
}) => {
  const { port } = await serveRenderer(onTestFinished);
  const get = await fetchRaw(port, "/", { "accept-encoding": "br" });
  const head = await fetchRaw(port, "/", { "accept-encoding": "br" }, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers["content-encoding"]).toBe("br");
  expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  expect(head.body.length).toBe(0);
  expect(get.body.length).toBeGreaterThan(0);
});

test("a rebuilt renderer file is served fresh instead of the cached body", async ({
  onTestFinished,
}) => {
  const { port, root, script } = await serveRenderer(onTestFinished);
  const first = await fetchRaw(port, "/assets/app.js", { "accept-encoding": "br" });
  expect(brotliDecompressSync(first.body).toString("utf8")).toBe(script);
  const rebuilt = `${script}\nconsole.log("rebuilt");\n`;
  await writeFile(join(root, "assets", "app.js"), rebuilt);
  const second = await fetchRaw(port, "/assets/app.js", { "accept-encoding": "br" });
  expect(brotliDecompressSync(second.body).toString("utf8")).toBe(rebuilt);
});

test("concurrent first requests each receive the complete compressed file", async ({
  onTestFinished,
}) => {
  const { port, script } = await serveRenderer(onTestFinished);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => fetchRaw(port, "/assets/app.js", { "accept-encoding": "br" })),
  );
  for (const response of responses)
    expect(brotliDecompressSync(response.body).toString("utf8")).toBe(script);
});

test("files outside the renderer stay unreachable", async ({ onTestFinished }) => {
  const { port, root, html } = await serveRenderer(onTestFinished);
  const outside = await mkdtemp(join(tmpdir(), "ace-web-outside-"));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.js"), "secret".repeat(400));
  await symlink(join(outside, "secret.js"), join(root, "assets", "linked.js"));
  const linked = await fetchRaw(port, "/assets/linked.js", { "accept-encoding": "br" });
  expect(linked.status).toBe(404);
  const traversal = await fetchRaw(port, "/assets/../../secret.js");
  expect(traversal.body.toString("utf8")).toBe(html);
});

test("daemon API and preview paths reach the next handler", async ({ onTestFinished }) => {
  const { port } = await serveRenderer(onTestFinished);
  for (const path of ["/v1/devices", "/preview/app"]) {
    const response = await fetchRaw(port, path, { "accept-encoding": "br" });
    expect(response.body.toString("utf8")).toBe("next");
  }
});

test("the web app's icons are served from the renderer root with image types", async ({
  onTestFinished,
}) => {
  const { port, root } = await serveRenderer(onTestFinished);
  await writeFile(join(root, "favicon.svg"), "<svg/>");
  await writeFile(join(root, "favicon.png"), "png bytes");
  await writeFile(join(root, "apple-touch-icon.png"), "touch bytes");
  const touch = await fetchRaw(port, "/apple-touch-icon.png");
  expect(touch.headers["content-type"]).toBe("image/png");
  expect(touch.body.toString("utf8")).toBe("touch bytes");
  expect((await fetchRaw(port, "/favicon.png")).body.toString("utf8")).toBe("png bytes");
  expect((await fetchRaw(port, "/favicon.svg")).headers["content-type"]).toBe("image/svg+xml");
});

test("other root files are not exposed; the page is served in their place", async ({
  onTestFinished,
}) => {
  const { port, root, html } = await serveRenderer(onTestFinished);
  await writeFile(join(root, "secret.png"), "private");
  const response = await fetchRaw(port, "/secret.png");
  expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(response.body.toString("utf8")).toBe(html);
});
