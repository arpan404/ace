import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  type IncomingHttpHeaders,
} from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createPreviewGateway, type PreviewChannel } from "./index.ts";

export type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
export async function http(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
): Promise<HttpResult> {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: address.pathname + address.search,
        method,
        headers: { host: address.host, ...headers },
        agent: false,
      },
      (res) => {
        let content = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          content += chunk;
        });
        res.once("error", reject);
        res.once("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: content }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}
export async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  port = 0,
) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await listen(server, port);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP port");
  return {
    server,
    port: address.port,
    url: `http://localhost:${address.port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
export async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
export async function gateway(
  options: {
    now?: () => number;
    limits?: { connections?: number; registrations?: number; links?: number };
  } = {},
) {
  let paired = true;
  const g = await createPreviewGateway({
    host: "127.0.0.1",
    wildcardHost: "preview.test",
    ...options,
    authority: {
      authorize: async (token) => (token === "paired-token" ? "device" : null),
      isPaired: async () => paired,
    },
  });
  return {
    ...g,
    revoke: () => {
      paired = false;
      g.revokeDevice("device");
    },
    login: async (port: number) => {
      const url = await g.mintLink({ port, deviceToken: "paired-token" });
      const res = await http(url);
      return { url, cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "", res };
    },
  };
}
export function echoWebsocket(server: Server) {
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => ws.on("message", (bytes, binary) => ws.send(bytes, { binary })));
  return wss;
}
export async function websocket(origin: string, cookie: string) {
  const url = new URL(origin);
  const ws = new WebSocket(`ws://127.0.0.1:${url.port}/hmr`, {
    headers: { Host: url.host, Origin: origin, Cookie: cookie },
  });
  await once(ws, "open");
  return ws;
}
export async function echo(ws: WebSocket, text: string) {
  const response = once(ws, "message");
  ws.send(text);
  const [value] = await response;
  return String(value);
}
/** Bounded ordered transport edge. A real secure-channel adapter has the same contract. */
export function channelPair() {
  type Receiver = { frame: (frame: Uint8Array) => void; close: () => void };
  let left: Receiver | undefined;
  let right: Receiver | undefined;
  let disconnected = false;
  const disconnect = () => {
    disconnected = true;
    left?.close();
    right?.close();
  };
  const a: PreviewChannel = {
    close: disconnect,
    async send(bytes) {
      if (disconnected) throw new Error("Disconnected");
      await new Promise<void>((done) => setImmediate(done));
      right?.frame(bytes);
    },
    subscribe(frame, close) {
      left = { frame, close };
      return () => {
        left = undefined;
      };
    },
  };
  const b: PreviewChannel = {
    close: disconnect,
    async send(bytes) {
      if (disconnected) throw new Error("Disconnected");
      await new Promise<void>((done) => setImmediate(done));
      left?.frame(bytes);
    },
    subscribe(frame, close) {
      right = { frame, close };
      return () => {
        right = undefined;
      };
    },
  };
  return { a, b, disconnect };
}
