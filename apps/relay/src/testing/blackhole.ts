import { createServer, connect, type Socket } from "node:net";

/** Real TCP relay proxy. Drop selected responses to model a half-open network connection. */
export async function blackholeRelay(url: string) {
  const upstream = new URL(url);
  const sockets = new Set<Socket>();
  const blocked = new Set<string>();
  let observe: (() => void) | undefined;
  const server = createServer((incoming) => {
    const outgoing = connect({ host: upstream.hostname, port: Number(upstream.port) });
    sockets.add(incoming);
    sockets.add(outgoing);
    let route: string | undefined;
    let headers = "";
    incoming.on("data", (bytes: Buffer) => {
      if (!route) {
        headers += bytes.toString("latin1");
        if (headers.length > 4096) return incoming.destroy();
        if (headers.includes("\r\n\r\n")) {
          route = headers.split(" ")[1]?.split("?")[0];
          headers = "";
        }
      }
      outgoing.write(bytes);
    });
    outgoing.on("data", (bytes: Buffer) => {
      if (route && blocked.has(route)) return;
      incoming.write(bytes);
      if (route === "/host") {
        observe?.();
        observe = undefined;
      }
    });
    const close = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on("error", close);
    outgoing.on("error", close);
    incoming.once("close", () => {
      sockets.delete(incoming);
      outgoing.destroy();
    });
    outgoing.once("close", () => {
      sockets.delete(outgoing);
      incoming.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    block(route: string) {
      blocked.add(route);
    },
    resume() {
      blocked.clear();
    },
    controlResponse: () =>
      new Promise<void>((resolve) => {
        observe = resolve;
      }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
