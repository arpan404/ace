import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join, normalize } from "node:path";
import { sceneRuntimeScript } from "@ace/suit-scene-runtime";

/*
 * The scene gallery's server: the gallery page, each scene's sandbox page and the real scene
 * runtime. A scene page gets the same CSP and sandbox the daemon gives a Suit's scene (ADR 0150),
 * so a scene that runs here runs unchanged as a Suit's scene.js.
 *
 *   bun tools/suit-gallery/src/serve.ts [--port 4870]
 */

const root = join(import.meta.dirname, "..");
const portFlag = process.argv.indexOf("--port");
const port = portFlag > 0 ? Number(process.argv[portFlag + 1]) : 4870;

/** The policy the daemon serves a scene page with (apps/daemon/src/suits/http.ts). */
const sceneCsp =
  "default-src 'none'; script-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; sandbox allow-scripts";

const scenePage = (name: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style>
</head><body><script src="runtime.js"></script><script src="${name}.js"></script></body></html>
`;

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};
const typeOf = (path: string) => types[path.slice(path.lastIndexOf("."))] ?? "text/plain";
const sceneName = /^[a-z][a-z0-9-]*$/;

function send(
  response: ServerResponse,
  body: string | Buffer,
  type: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  response.end(body);
}

function missing(response: ServerResponse) {
  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("Not found");
}

async function file(response: ServerResponse, path: string, headers: Record<string, string> = {}) {
  try {
    send(response, await readFile(path), typeOf(path), headers);
  } catch {
    missing(response);
  }
}

async function serve(path: string, response: ServerResponse) {
  // /scene/<name>.html, /scene/runtime.js and /scene/<name>.js: one scene's sandbox.
  const scene = /^\/scene\/([^/]+)\.(html|js)$/.exec(path);
  if (scene) {
    const [, name = "", kind] = scene;
    const sandbox = { "Content-Security-Policy": sceneCsp };
    if (kind === "js" && name === "runtime")
      return send(response, sceneRuntimeScript, typeOf(".js"), sandbox);
    if (!sceneName.test(name)) return missing(response);
    if (kind === "html") return send(response, scenePage(name), typeOf(".html"), sandbox);
    return file(response, join(root, "scenes", name, "scene.js"), sandbox);
  }
  // /scenes/<name>/palette.json: the gallery's glass tint and accent for a scene.
  const palette = /^\/scenes\/([^/]+)\/palette\.json$/.exec(path);
  if (palette?.[1] && sceneName.test(palette[1]))
    return file(response, join(root, "scenes", palette[1], "palette.json"));
  // /bench-frame/<name>.html: the runtime and a scene, same-origin and unsandboxed, so the bench
  // can drive it with real messages and wait for its canvases to finish drawing.
  const benchFrame = /^\/bench-frame\/([^/]+)\.html$/.exec(path);
  if (benchFrame?.[1] && sceneName.test(benchFrame[1]))
    return send(
      response,
      `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body><script src="/bench-runtime.js"></script><script src="/bench/${benchFrame[1]}.js"></script></body></html>`,
      typeOf(".html"),
    );
  if (path === "/bench-runtime.js") return send(response, sceneRuntimeScript, typeOf(".js"));
  // /bench/<name>.js: a scene's own file, loaded unsandboxed by the frame-time bench.
  const bench = /^\/bench\/([^/]+)\.js$/.exec(path);
  if (bench?.[1] && sceneName.test(bench[1]))
    return file(response, join(root, "scenes", bench[1], "scene.js"));
  const page = normalize(path === "/" ? "/index.html" : path);
  if (page.includes("..")) return missing(response);
  return file(response, join(root, "page", page));
}

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  serve(path, response).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`Suit scene gallery: http://127.0.0.1:${port}/`);
});
