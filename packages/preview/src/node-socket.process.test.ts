import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { previewSocket } from "./node-socket.ts";
import { windowSize } from "./relay-wire.ts";

// A real socket: how a read larger than a window is held back depends on the runtime's streams.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

test("a socket read larger than a window reaches the relay in order, one window at a time", async () => {
  const server = createServer({ allowHalfOpen: true });
  cleanup.push(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const accepted = once(server, "connection") as Promise<[Socket]>;
  const client = connect(address.port, "127.0.0.1");
  cleanup.push(() => client.destroy());
  const [raw] = await accepted;
  raw.pause();
  // Bun reads up to 512 KiB at once; put such a read back at the head of the socket.
  const big = Buffer.from(Array.from({ length: 600_000 }, (_, i) => i % 251));
  raw.unshift(big);
  client.end(Buffer.from([7, 7, 7]));

  const socket = previewSocket(raw);
  const pieces: Uint8Array[] = [];
  let endedAfter = -1;
  const ended = new Promise<void>((resolve) =>
    socket.on("end", () => {
      endedAfter = pieces.length;
      resolve();
    }),
  );
  socket.on("data", (bytes) => {
    // As the mux does: pause while one chunk is sent, resume once it has gone.
    pieces.push(Buffer.from(bytes));
    socket.pause();
    setImmediate(() => socket.resume());
  });
  socket.resume();
  await ended;

  expect(pieces.every((piece) => piece.byteLength <= windowSize)).toBe(true);
  expect(Buffer.concat(pieces)).toEqual(Buffer.concat([big, Buffer.from([7, 7, 7])]));
  expect(endedAfter).toBe(pieces.length);
});
