import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ClientMessage } from "@ace/protocol";
import { expect, it, vi } from "vitest";
import { DesktopLink } from "./desktop-link.ts";

it("the background paired device mints a separate ticket on reconnect and stops after revocation", async () => {
  const token = "a".repeat(64);
  const issued = new Set<string>();
  const welcomes: string[] = [];
  let counter = 0;
  let revoked = false;
  const server = createServer((request, response) => {
    if (
      revoked ||
      request.url !== "/v1/tickets" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401).end();
      return;
    }
    const ticket = (++counter).toString(16).padStart(64, "0");
    issued.add(ticket);
    response.end(JSON.stringify({ ticket, expiresAt: 10000 }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const frame = ClientMessage.parse(JSON.parse(bytes.toString()));
      if (frame.type !== "hello") return;
      if (
        !frame.ticket ||
        !issued.delete(frame.ticket) ||
        frame.deviceId !== "paired-read-device"
      ) {
        socket.close(4001);
        return;
      }
      welcomes.push(frame.ticket);
      socket.send(
        JSON.stringify({ type: "welcome", protocolVersion: 1, hostId: "host", headSeq: 0 }),
      );
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const link = new DesktopLink({
    url: `ws://127.0.0.1:${address.port}/`,
    token,
    pairedDeviceId: "paired-read-device",
    deviceId: "unrelated-installation-device",
    storage: { load: async () => null, save: async () => {} },
    quietHours: () => null,
    onAlert: () => {},
    onSummary: () => {},
  });
  try {
    await link.start();
    await vi.waitFor(() => expect(welcomes).toHaveLength(1), { timeout: 10000 });
    for (const socket of sockets.clients) socket.terminate();
    link.wake();
    await vi.waitFor(() => expect(welcomes).toHaveLength(2), { timeout: 10000 });
    expect(welcomes[1]).not.toBe(welcomes[0]);
    revoked = true;
    for (const socket of sockets.clients) socket.terminate();
    link.wake();
    await vi.waitFor(() => expect(link.fatal()).toBe(true), { timeout: 10000 });
    expect(welcomes).toHaveLength(2);
  } finally {
    await link.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
