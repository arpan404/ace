import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { preview, type Plugin } from "vite";

/*
 * Built files under `/assets/` carry a hash of their content in their name, and ace's own server
 * tells a browser to keep them for good (apps/daemon/src/web-http.ts); the desktop app reads them
 * from its own protocol. `vite preview` asks the browser to check every file again, so a reload
 * in a run would ask for every chunk of the app again, six at a time over HTTP/1.1, which a person
 * reloading ace never waits on. Here they are served as ace serves them.
 */
const hashedAssetCache = "public, max-age=31536000, immutable";
const types: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function hashedAssets(outDir: string): Plugin {
  const assets = resolve(outDir, "assets") + sep;
  const serve = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = new URL(request.url ?? "/", "http://preview").pathname;
    const file = resolve(join(outDir, decodeURIComponent(path)));
    const type = types[extname(file)];
    if (request.method !== "GET" || !file.startsWith(assets) || !type) return next();
    readFile(file).then(
      (body) => {
        response.setHeader("Content-Type", type);
        response.setHeader("Cache-Control", hashedAssetCache);
        response.end(body);
      },
      () => next(),
    );
  };
  return {
    name: "ace-hashed-assets",
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

/** Serve this run's built app and wait for its own listener before opening a browser. */
export async function startPreview(root: string, outDir: string) {
  const server = await preview({
    root,
    configFile: false,
    logLevel: "silent",
    build: { outDir },
    plugins: [hashedAssets(outDir)],
    preview: { port: 0, strictPort: true, host: "127.0.0.1" },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Performance preview has no TCP listener");
  }
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}
