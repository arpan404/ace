import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import { attachPreviewRelay } from "./index.ts";
import { channelPair } from "./test-support.ts";

test("an otherwise-valid oversized DATA frame closes the relay before reaching a real upstream", async () => {
  const sockets = new Set<Socket>();
  let received = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (bytes) => {
      received += bytes.length;
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No upstream address");
  const channels = channelPair();
  const host = attachPreviewRelay({
    channel: channels.b,
    allowPort: async (port) => port === address.port,
  });
  let ready: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let peerClosed = false;
  channels.a.subscribe(
    (bytes) => {
      if (bytes[1] === 2) ready?.();
    },
    () => {
      peerClosed = true;
    },
  );
  try {
    const open = new Uint8Array(12);
    const header = new DataView(open.buffer);
    header.setUint8(0, 1);
    header.setUint8(1, 1);
    header.setUint32(4, 1);
    header.setUint32(8, address.port);
    await channels.a.send(open);
    await connected;
    const oversized = new Uint8Array(16_397);
    const dataHeader = new DataView(oversized.buffer);
    dataHeader.setUint8(0, 1);
    dataHeader.setUint8(1, 3);
    dataHeader.setUint32(4, 1);
    dataHeader.setUint32(8, 16_385);
    oversized.fill(42, 12);
    await channels.a.send(oversized);
    expect(peerClosed).toBe(true);
    expect(received).toBe(0);
  } finally {
    host.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
