import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { probe } from "./probe.ts";

test("the smoke probe pings while idle and rejects outstanding requests on transport loss", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing listener");
  let heartbeat: (() => void) | undefined;
  const pinged = Promise.withResolvers<void>(),
    pending = Promise.withResolvers<void>();
  const connected = once(server, "connection");
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(data.toString());
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "ping") pinged.resolve();
      if (message.type === "history.scan") pending.resolve();
    }),
  );
  const client = await probe(`ws://127.0.0.1:${address.port}`, "a".repeat(64), (run) => {
    heartbeat = run;
    return () => {
      heartbeat = undefined;
    };
  });
  try {
    heartbeat?.();
    await pinged.promise;
    const request = client.request({ type: "history.scan", action: "status" });
    const rejected = expect(request).rejects.toThrow("Probe connection closed");
    await pending.promise;
    (await connected)[0].terminate();
    await rejected;
    await expect(client.request({ type: "history.scan", action: "status" })).rejects.toThrow(
      "Probe connection closed",
    );
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
