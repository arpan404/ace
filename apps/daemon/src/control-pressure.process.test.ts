import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { Outbox, defaultPressure, RESYNC_CLOSE_CODE } from "./outbox.ts";

test("a control reply that cannot fit the client budget closes for replay before sending its payload", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const connection = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const opened = once(client, "open");
  const [socket] = await connection;
  if (!(socket instanceof WebSocket)) throw new Error("No socket");
  await opened;
  const payloads: string[] = [];
  client.on("message", (data) => payloads.push(data.toString()));
  try {
    const closed = once(client, "close");
    new Outbox(socket, { ...defaultPressure, hardLimit: 256 }).send({
      type: "error",
      code: "large",
      message: "x".repeat(512),
    });
    const [code] = await closed;
    expect(code).toBe(RESYNC_CLOSE_CODE);
    expect(payloads).toEqual([]);
  } finally {
    client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
