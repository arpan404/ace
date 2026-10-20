import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RequestListener } from "node:http";
import { compressedFiles } from "./compressed-files.ts";
import { negotiateContentEncoding } from "./content-encoding.ts";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
/** The web app's icons, copied to the build's root from `apps/web/public`. */
const icons = new Set(["/favicon.svg", "/favicon.png", "/apple-touch-icon.png"]);
const compressible = new Set([".html", ".js", ".css", ".svg"]);
/**
 * Built files under `/assets/` carry a hash of their content in their name, so a browser keeps
 * them for good: a remote device then downloads a lazy screen's code once, not on every visit.
 * The page and the icons keep their names across builds, so they are always asked for again.
 */
const hashedAssetCache = "public, max-age=31536000, immutable";
/** Serve only the shipped renderer. No workspace or user-home files are reachable. */
export function webHttp(root: string | undefined, next: RequestListener): RequestListener {
  const compressed = compressedFiles(32 * 1024 * 1024);
  return (request, response) => {
    const path = request.url ?? "";
    if (!root || path.startsWith("/v1/") || path.startsWith("/preview/")) {
      next(request, response);
      return;
    }
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        next(request, response);
        return;
      }
      const name = decodeURIComponent(new URL(path, "http://localhost").pathname);
      const directory = await realpath(root);
      const hashed = name.startsWith("/assets/");
      const asset = hashed || icons.has(name);
      const file = await realpath(resolve(directory, asset ? `.${name}` : "index.html"));
      if (!file.startsWith(directory + sep)) throw new Error("Outside renderer");
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Missing renderer file");
      const extension = extname(file);
      const encoding =
        compressible.has(extension) && info.size >= 1024
          ? negotiateContentEncoding(request.headers["accept-encoding"])
          : undefined;
      response.setHeader("Content-Type", types[extension] ?? "application/octet-stream");
      response.setHeader("Cache-Control", hashed ? hashedAssetCache : "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (compressible.has(extension)) response.setHeader("Vary", "Accept-Encoding");
      const body =
        encoding &&
        (await compressed(file, encoding, info.size, info.mtimeMs).catch(() => undefined));
      if (encoding && body) {
        response.setHeader("Content-Encoding", encoding);
        response.setHeader("Content-Length", body.length);
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      response.setHeader("Content-Length", info.size);
      if (request.method === "HEAD") response.end();
      else await pipeline(createReadStream(file), response);
    })().catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.statusCode = 404;
      response.end(
        "The ace web app is unavailable. Build or reinstall ace, then open the pairing link again.",
      );
    });
  };
}
