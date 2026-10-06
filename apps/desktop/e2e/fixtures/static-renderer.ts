import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { once } from "node:events";

export async function staticRenderer(root: string) {
  const types: Readonly<Record<string, string>> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const asset =
      path.startsWith("/assets/") && !path.includes("..") ? path.slice(1) : "index.html";
    void readFile(join(root, asset)).then(
      (bytes) => {
        res.setHeader("content-type", types[extname(asset)] ?? "text/html");
        res.end(bytes);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No renderer port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
