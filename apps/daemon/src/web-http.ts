import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RequestListener } from "node:http";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
/** Serve only the shipped renderer. No workspace or user-home files are reachable. */
export function webHttp(root: string | undefined, next: RequestListener): RequestListener {
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
      const asset = name.startsWith("/assets/") || name === "/favicon.svg";
      const file = await realpath(resolve(directory, asset ? `.${name}` : "index.html"));
      if (!file.startsWith(directory + sep)) throw new Error("Outside renderer");
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Missing renderer file");
      response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
      response.setHeader("Content-Length", info.size);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
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
