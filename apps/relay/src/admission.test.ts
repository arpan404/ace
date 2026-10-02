import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { expect, it } from "vitest";
import { startRelay } from "./index.ts";

async function dial(port: number): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  await once(socket, "connect");
  return socket;
}

it.each([
  { maxConnections: 1, maxConnectionsPerIp: 8 },
  { maxConnections: 8, maxConnectionsPerIp: 1 },
])("partial HTTP headers consume admission capacity: %j", async (limits) => {
  const relay = await startRelay({ limits });
  const sockets: Socket[] = [];
  try {
    const partial = await dial(relay.port);
    sockets.push(partial);
    partial.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
    const excess = await dial(relay.port);
    sockets.push(excess);
    const response = once(excess, "data");
    excess.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    expect(String((await response)[0])).toContain("429 Too Many Requests");
    const ended = once(partial, "close");
    partial.destroy();
    await ended;
    const next = await dial(relay.port);
    sockets.push(next);
    const accepted = once(next, "data");
    next.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    expect(String((await accepted)[0])).toContain("404 Not Found");
  } finally {
    for (const socket of sockets) socket.destroy();
    await relay.close();
  }
});

it("shutdown closes partial HTTP headers and bodies without waiting for peers", async () => {
  const relay = await startRelay();
  const sockets = await Promise.all([dial(relay.port), dial(relay.port)]);
  const closed = sockets.map((socket) => once(socket, "close"));
  sockets[0]?.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
  const body = sockets[1];
  if (!body) throw new Error("missing body peer");
  const response = once(body, "data");
  body.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10000\r\n\r\nx");
  await response;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      Promise.all([relay.close(), ...closed]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    expect(completed).toBe(true);
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await relay.close();
  }
});
