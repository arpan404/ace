import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { previewSocket } from "./node-socket.ts";
import { systemTimer } from "./relay-mux.ts";
import { windowSize } from "./relay-wire.ts";

// A real socket: how a read larger than a window is held back depends on the runtime's streams.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function connectedPair() {
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
  return { raw, client };
}

/** Reads the adapter as the mux does: pause while one chunk is sent, resume once it has gone. */
function readLikeTheMux(raw: Socket, onPiece: (count: number) => void = () => {}) {
  const socket = previewSocket(raw, systemTimer);
  const pieces: Uint8Array[] = [];
  let endedAfter = -1;
  let closedAfterEnd = false;
  const ended = new Promise<void>((resolve) =>
    socket.on("end", () => {
      endedAfter = pieces.length;
      resolve();
    }),
  );
  const closed = new Promise<void>((resolve) =>
    socket.on("close", () => {
      closedAfterEnd = endedAfter >= 0;
      resolve();
    }),
  );
  socket.on("data", (bytes) => {
    pieces.push(Buffer.from(bytes));
    socket.pause();
    onPiece(pieces.length);
    setImmediate(() => socket.resume());
  });
  socket.resume();
  return {
    pieces,
    endedAfter: () => endedAfter,
    closedAfterEnd: () => closedAfterEnd,
    ended,
    closed,
  };
}

const pattern = (length: number, seed = 0) =>
  Buffer.from(Array.from({ length }, (_, i) => (i + seed) % 251));

test("a socket read larger than a window reaches the relay in order, one window at a time", async () => {
  const { raw, client } = await connectedPair();
  // Bun reads up to 512 KiB at once; put such a read back at the head of the socket.
  const big = pattern(600_000);
  raw.unshift(big);
  client.end(Buffer.from([7, 7, 7]));

  const read = readLikeTheMux(raw);
  await read.ended;

  expect(read.pieces.every((piece) => piece.byteLength <= windowSize)).toBe(true);
  expect(Buffer.concat(read.pieces)).toEqual(Buffer.concat([big, Buffer.from([7, 7, 7])]));
  expect(read.endedAfter()).toBe(read.pieces.length);
});

test(
  "the end of a socket whose last read was larger than a window waits for every byte",
  { timeout: 10_000 },
  async () => {
    const { raw, client } = await connectedPair();
    const last = pattern(512 * 1024);
    raw.unshift(last);
    client.end();

    const read = readLikeTheMux(raw);
    await read.ended;

    expect(Buffer.concat(read.pieces)).toEqual(last);
    expect(read.endedAfter()).toBe(read.pieces.length);
    // The close that follows reaches the relay after the end, not before it.
    raw.end();
    await read.closed;
    expect(read.closedAfterEnd()).toBe(true);
  },
);

test("data that arrives while bytes are held queues behind them", { timeout: 10_000 }, async () => {
  const { raw, client } = await connectedPair();
  const first = pattern(300_000);
  const small = Buffer.from([1, 2, 3]);
  const second = pattern(400_000, 17);
  raw.unshift(first);

  const read = readLikeTheMux(raw, (count) => {
    // While the first read is still held, more arrives: one small chunk and one oversized.
    if (count !== 1) return;
    raw.emit("data", small);
    raw.emit("data", second);
    client.end();
  });
  await read.ended;

  expect(read.pieces.every((piece) => piece.byteLength <= windowSize)).toBe(true);
  expect(Buffer.concat(read.pieces)).toEqual(Buffer.concat([first, small, second]));
  expect(read.endedAfter()).toBe(read.pieces.length);
});

test(
  "a paused socket never holds more than one read while a long upload is relayed",
  { timeout: 20_000 },
  async () => {
    const { raw, client } = await connectedPair();
    const upload = pattern(4 * 1024 * 1024, 5);
    client.end(upload);
    // Let the upload fill the kernel buffer, so every resume of the socket can read at once.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Chunks already wait in the paused socket, as after a send that waited for credit.
    const first = pattern(100_000);
    const second = pattern(100_000, 3);
    raw.unshift(second);
    raw.unshift(first);

    let maxPaused = 0;
    const read = readLikeTheMux(raw, () => {
      maxPaused = Math.max(maxPaused, raw.readableLength);
    });
    await read.ended;

    expect(Buffer.concat(read.pieces)).toEqual(Buffer.concat([first, second, upload]));
    // Bun reads up to 512 KiB at a time and a paused socket may hold one such read, never two.
    expect(maxPaused).toBeLessThanOrEqual(524_288);
  },
);
