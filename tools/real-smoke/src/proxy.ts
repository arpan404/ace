import { createServer, request as httpRequest } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage } from "@ace/protocol";
import { smokeMessage } from "./policy.ts";
import type { Finding } from "./checks.ts";

/** Guard outside the page, so SharedWorker and dedicated-worker clients are covered too. */
export async function guardProxy(target: string, onFailure: (finding: Finding) => void) {
  let allowedOrigin = "";
  const http = createServer((request, response) => {
    const path = request.url ?? "";
    const origin = request.headers.origin;
    if (
      origin !== allowedOrigin ||
      !["/v1/status", "/v1/devices"].includes(path) ||
      !["GET", "OPTIONS"].includes(request.method ?? "")
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const headers = {
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    const address = new URL(target);
    address.protocol = "http:";
    address.pathname = path;
    const upstream = httpRequest(
      address,
      {
        method: "GET",
        headers: request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {},
      },
      (result) => {
        response.writeHead(result.statusCode ?? 502, {
          ...headers,
          "content-type": "application/json",
        });
        result.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502, headers);
      response.end();
    });
    response.on("close", () => upstream.destroy());
    upstream.end();
  });
  const server = new WebSocketServer({ server: http, maxPayload: 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string" || address.port === 4242)
    throw new Error("Unsafe smoke proxy port");
  const peers = new Set<WebSocket>();
  server.on("connection", (browser) => {
    const upstream = new WebSocket(target, { maxPayload: 2 * 1024 * 1024 });
    peers.add(browser);
    peers.add(upstream);
    const pending: string[] = [];
    upstream.on("open", () => {
      for (const text of pending) upstream.send(text);
      pending.length = 0;
    });
    browser.on("message", (data) => {
      const text = data.toString();
      let label = "an invalid client request";
      try {
        const request = ClientMessage.safeParse(JSON.parse(text));
        if (request.success)
          label = `${request.data.type}${request.data.type === "command" ? "." + request.data.command.payload.type : ""}${request.data.type === "pluginRequest" ? "." + request.data.request.type : ""}${"operation" in request.data && typeof request.data.operation === "object" && "op" in request.data.operation ? "." + request.data.operation.op : ""}`;
        smokeMessage(JSON.parse(text));
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else if (pending.length < 64) pending.push(text);
        else throw new Error("Smoke socket exceeded startup queue budget");
      } catch {
        onFailure({
          code: "refused-command",
          message: `Smoke refused ${label}`,
        });
        browser.close(1008, "Smoke read-only policy");
        upstream.close();
      }
    });
    upstream.on("message", (data) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
    });
    browser.on("close", () => {
      peers.delete(browser);
      upstream.close();
    });
    upstream.on("close", () => {
      peers.delete(upstream);
      browser.close();
    });
    for (const peer of [browser, upstream])
      peer.on("error", () => {
        onFailure({ code: "socket-error", message: "Smoke daemon connection failed" });
        browser.close();
        upstream.close();
      });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    allowOrigin(origin: string) {
      allowedOrigin = origin;
    },
    close: async () => {
      for (const peer of peers) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
