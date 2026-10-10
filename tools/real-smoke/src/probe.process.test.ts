import { once } from "node:events";
import { WebSocketServer } from "ws";
import { ClientMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { probe } from "./probe.ts";

test("the smoke probe keeps its socket active and rejects an outstanding read with the close reason", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing probe port");
  const connected = once(server, "connection");
  let ping: (() => void) | undefined;
  const inspector = await probe(`ws://127.0.0.1:${address.port}`, "a".repeat(64), {
    repeat(callback) {
      ping = callback;
      return () => {
        ping = undefined;
      };
    },
  });
  const [socket] = await connected;
  const pinged = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  socket.on("message", (frame: Buffer) => {
    const message = ClientMessage.parse(JSON.parse(frame.toString()));
    if (message.type === "ping") pinged.resolve();
    if (message.type === "history.scan") {
      requested.resolve();
      socket.close(4008, "Idle deadline");
    }
  });
  try {
    ping?.();
    await pinged.promise;
    const read = inspector.request({ type: "history.scan", operation: "status" });
    await requested.promise;
    await expect(read).rejects.toThrow("Probe closed (4008): Idle deadline");
    await expect(inspector.request({ type: "accounts.list" })).rejects.toThrow("Idle deadline");
    expect(ping).toBeUndefined();
  } finally {
    inspector.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
