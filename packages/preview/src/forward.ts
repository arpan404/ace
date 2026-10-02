import { Agent, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { connect as connectSocket } from "node:net";
import { loopbackConnection } from "./loopback.ts";
import { requestHeaders, responseHeaders } from "./headers.ts";

export type Target = { port: number; origin: string; connect?: () => Duplex };
function forwardingAgent(target: Target): Agent {
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = target.connect ?? (() => connectSocket(loopbackConnection(target.port)));
  return agent;
}
export type Track = (cancel: () => void, bufferedBytes: () => number) => () => void;
export function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: Target,
  track: Track,
): void {
  const agent = forwardingAgent(target);
  const upstream = request({
    hostname: "localhost",
    port: target.port,
    path: req.url,
    method: req.method,
    headers: requestHeaders(req.headers, target.port),
    agent,
  });
  upstream.once("close", () => {
    agent.destroy();
  });
  let responseBody: IncomingMessage | undefined;
  const release = track(
    () => {
      upstream.destroy();
      res.destroy();
    },
    () =>
      req.readableLength +
      upstream.writableLength +
      res.writableLength +
      (responseBody?.readableLength ?? 0),
  );
  res.once("close", () => {
    upstream.destroy();
    release();
  });
  req.once("aborted", () => upstream.destroy());
  req.once("error", () => upstream.destroy());
  upstream.once("error", () => {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(502);
      res.end("Preview upstream unavailable");
    }
  });
  upstream.once("response", (response) => {
    responseBody = response;
    res.writeHead(
      response.statusCode ?? 502,
      responseHeaders(response.headers, target.port, target.origin),
    );
    res.flushHeaders();
    response.once("error", () => res.destroy());
    response.pipe(res);
  });
  req.pipe(upstream);
}
export function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: Target,
  track: Track,
): void {
  const headers = requestHeaders(req.headers, target.port);
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  const agent = forwardingAgent(target);
  const upstream = request({
    hostname: "localhost",
    port: target.port,
    method: "GET",
    path: req.url,
    headers,
    agent,
  });
  upstream.once("close", () => {
    agent.destroy();
  });
  let peer: Duplex | undefined;
  const cancel = () => {
    upstream.destroy();
    peer?.destroy();
    socket.destroy();
  };
  const release = track(
    cancel,
    () =>
      socket.readableLength +
      socket.writableLength +
      (peer?.readableLength ?? 0) +
      (peer?.writableLength ?? 0),
  );
  socket.once("close", () => {
    cancel();
    release();
  });
  socket.once("error", cancel);
  upstream.once("error", cancel);
  upstream.once("response", () =>
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"),
  );
  upstream.once("upgrade", (response, remote, remoteHead) => {
    peer = remote;
    remote.once("error", cancel);
    remote.once("close", () => socket.destroy());
    const out = responseHeaders(response.headers, target.port, target.origin);
    out.connection = "Upgrade";
    out.upgrade = "websocket";
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const [name, value] of Object.entries(out)) {
      if (value !== undefined)
        for (const part of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${part}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.pipe(socket);
    socket.pipe(remote);
    socket.resume();
  });
  upstream.end();
}
