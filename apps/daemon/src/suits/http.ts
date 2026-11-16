import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { sceneRuntimeScript } from "@ace/suit-scene-runtime";
import { isSceneFile } from "@ace/suits";
import type { SuitLibrary } from "./library.ts";
import { suitsPathPrefix } from "./urls.ts";

/*
 * `GET /v1/suits/<id>/<hash>/<grant>/<file>` (`urls.ts`): a Suit's scene page, its scene.js and
 * its assets. The grant in the path is the only authority; cookies and headers are ignored and
 * nothing is set that could carry one. Every response is sandboxed by its CSP, so a file opened
 * on its own runs nowhere near the daemon's origin.
 */

/** The scene page's policy (ADR 0150), sandboxed even when opened outside an iframe. */
export const sceneCsp =
  "default-src 'none'; script-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; sandbox allow-scripts";
/** Files are data: an SVG or HTML among the assets can't run anything. */
const fileCsp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

const runtimeBytes = Buffer.from(sceneRuntimeScript);
/**
 * ace's scene runtime, served beside every Suit's scene.js under the same grant. A Suit's own
 * files are only scene.js and assets/, so this name never shadows one of them. Its name carries
 * its own hash: the Suit's URL is cached as immutable, and the runtime changes with ace.
 */
export const sceneRuntimeFile = `scene-runtime-${createHash("sha256").update(runtimeBytes).digest("hex").slice(0, 16)}.js`;

/**
 * A scene's page: the runtime first (it makes the one canvas and speaks to ace), then the
 * Suit's scene file (`scene.js`, or a region's own), which calls `ace.scene({...})`. Both load
 * same-origin, as `script-src 'self'` asks. `script` is a checked root file name (`isSceneFile`).
 * The page names its colour schemes: a frame whose page names none is drawn on an opaque white
 * canvas when ace runs dark, and a celebration over the UI must stay clear where it draws nothing.
 */
export const scenePageFor = (script: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style>
</head><body><script src="${sceneRuntimeFile}"></script><script src="${script}"></script></body></html>
`;
export const scenePage = scenePageFor("scene.js");

/** The scene file a page path names (`city.html` → `city.js`), if it names one. */
const pageScript = (file: string) => {
  if (!file.endsWith(".html")) return undefined;
  const script = `${file.slice(0, -".html".length)}.js`;
  return isSceneFile(script) ? script : undefined;
};

const jsType = "text/javascript; charset=utf-8";
const types: Record<string, string> = {
  ".js": jsType,
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function suitsHttp(
  library: () => SuitLibrary | undefined,
  origins: ReadonlySet<string>,
  next: (request: IncomingMessage, response: ServerResponse) => void,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split("?")[0] ?? "";
    if (!path.startsWith(suitsPathPrefix)) {
      next(request, response);
      return;
    }
    void serve(request, response, path).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    });
  };

  async function serve(request: IncomingMessage, response: ServerResponse, path: string) {
    request.resume();
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Fonts load cross-origin from the web app; nothing here is credentialed.
    const origin = request.headers.origin;
    if (origin && origins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const suits = library();
    const target = suits?.urls.parse(path);
    if (!suits || !target) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const script = pageScript(target.file);
    const scene = script !== undefined;
    const runtime = target.file === sceneRuntimeFile;
    // A page and the runtime exist only for a Suit whose current version has that scene file;
    // the runtime rides on any scene file the Suit has.
    const file = runtime
      ? await suits.anyScene(target.id, target.hash)
      : await suits.file(target.id, target.hash, script ?? target.file);
    if (!file) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const body = scene ? Buffer.from(scenePageFor(file.path)) : runtime ? runtimeBytes : file.bytes;
    response.setHeader("Content-Security-Policy", scene ? sceneCsp : fileCsp);
    response.setHeader(
      "Content-Type",
      scene
        ? "text/html; charset=utf-8"
        : runtime
          ? jsType
          : (types[extname(file.path).toLowerCase()] ?? "application/octet-stream"),
    );
    if (scene) {
      // A scene page names ace's runtime, which changes with ace while the Suit's URL doesn't:
      // the page is checked again each time a frame loads it, by its checksum.
      const tag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
      response.setHeader("Cache-Control", "private, no-cache");
      response.setHeader("ETag", tag);
      if (request.headers["if-none-match"] === tag) {
        response.statusCode = 304;
        response.end();
        return;
      }
    } else {
      // The path names one version of the Suit (and the runtime's name its hash), so what it
      // serves never changes.
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    }
    response.setHeader("Content-Length", body.byteLength);
    response.statusCode = 200;
    response.end(request.method === "HEAD" ? undefined : body);
  }
}
