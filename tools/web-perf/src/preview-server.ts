import { preview } from "vite";

/** Serve this run's built app and wait for its own listener before opening a browser. */
export async function startPreview(root: string, outDir: string) {
  const server = await preview({
    root,
    configFile: false,
    logLevel: "silent",
    build: { outDir },
    preview: { port: 0, strictPort: true, host: "127.0.0.1" },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Performance preview has no TCP listener");
  }
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}
