import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { FRAME_LIMIT, FrameReader } from "./socket.ts";

// What the relay's frame reader does with the buffers it holds (ADR 0155): a client's first
// frames are first-flight material, so everything it drops is zero-filled, and a frame taken
// while the client is unpaired is zero-filled once it has been forwarded.

/** Enough of a ws socket for the reader: messages in, pause and resume. */
function socket() {
  const events = new EventEmitter();
  return Object.assign(events, { pause() {}, resume() {}, close() {} }) as unknown as WebSocket &
    EventEmitter;
}
const frame = (n: number, size = 40) => Buffer.alloc(size, n);
const wiped = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

it("a frame dropped on arrival is zero-filled", () => {
  const ws = socket();
  const reader = new FrameReader(ws, { onFrame: () => false });
  const dropped = frame(7);
  ws.emit("message", dropped, true);
  expect(wiped(dropped)).toBe(true);
  expect(reader.bufferedBytes).toBe(0);
});

it("a frame refused for its size is zero-filled", () => {
  const ws = socket();
  const reader = new FrameReader(ws, { refuse: () => {} });
  const large = frame(7, FRAME_LIMIT + 1);
  ws.emit("message", large, true);
  expect(wiped(large)).toBe(true);
  expect(reader.bufferedBytes).toBe(0);
});

it("frames still queued when the reader fails are zero-filled, the injected one included", () => {
  const ws = socket();
  const reader = new FrameReader(ws);
  const first = frame(1);
  reader.inject(first);
  const second = frame(2);
  ws.emit("message", second, true);
  reader.fail(new Error("Turned away"));
  expect(wiped(first)).toBe(true);
  expect(wiped(second)).toBe(true);
});

it("an injected first message is held as it is, not copied", async () => {
  const reader = new FrameReader(socket());
  const first = frame(1);
  reader.inject(first);
  expect(await reader.next()).toBe(first);
});

it("a frame taken while the client is unpaired is zero-filled once forwarded, and a later one isn't", async () => {
  const ws = socket();
  let unpaired = true;
  const reader = new FrameReader(ws, { sensitive: () => unpaired });
  const early = frame(1);
  ws.emit("message", early, true);
  unpaired = false;
  const later = frame(2);
  ws.emit("message", later, true);
  const taken = await reader.next();
  let sent!: () => void;
  const written = new Promise<void>((resolve) => (sent = resolve));
  reader.wipeWhenSent(taken, written);
  // Not before the write is done: the socket may still be sending it.
  expect(wiped(early)).toBe(false);
  sent();
  await written;
  await Promise.resolve();
  expect(wiped(early)).toBe(true);
  const next = await reader.next();
  reader.wipeWhenSent(next, Promise.resolve());
  await Promise.resolve();
  expect(wiped(later)).toBe(false);
});

it("a first-flight frame taken while its throttle wait is pending is wiped when the wait fails", async () => {
  const ws = socket();
  let refuse!: (error: Error) => void;
  const reader = new FrameReader(ws, {
    sensitive: () => true,
    permit: () => new Promise<void>((_resolve, reject) => (refuse = reject)),
  });
  const early = frame(1);
  ws.emit("message", early, true);
  const taken = reader.next();
  await Promise.resolve();
  refuse(new Error("Disconnected"));
  await expect(taken).rejects.toThrow();
  expect(wiped(early)).toBe(true);
});

it("a first-flight frame whose reader failed during its throttle wait is wiped", async () => {
  const ws = socket();
  let allow!: () => void;
  const reader = new FrameReader(ws, {
    sensitive: () => true,
    permit: () => new Promise<void>((resolve) => (allow = resolve)),
  });
  const early = frame(1);
  ws.emit("message", early, true);
  const taken = reader.next();
  await Promise.resolve();
  reader.fail(new Error("Disconnected"));
  allow();
  await expect(taken).rejects.toThrow();
  expect(wiped(early)).toBe(true);
});

it("a forwarded first-flight frame refused by the relay's buffer cap is wiped", async () => {
  const { pairStreams } = await import("./forward.ts");
  const peer = (bufferedAmount: number) => {
    const ws = Object.assign(socket(), {
      readyState: 1,
      OPEN: 1,
      bufferedAmount,
      send: (_data: unknown, _options: unknown, done?: (error?: Error) => void) => done?.(),
      terminate() {},
    });
    return ws;
  };
  const clientSocket = peer(0);
  const hostSocket = peer(Number.MAX_SAFE_INTEGER);
  const client = {
    socket: clientSocket,
    reader: new FrameReader(clientSocket, { sensitive: () => true }),
  };
  const host = { socket: hostSocket, reader: new FrameReader(hostSocket) };
  const early = frame(1);
  clientSocket.emit("message", early, true);
  pairStreams(
    client as never,
    host as never,
    { maxBufferedBytes: 1024, highWaterBytes: 512 } as never,
    {
      peakBufferedBytes: 0,
      pausedReaders: 0,
      forwardedFrames: 0,
      throttledFrames: 0,
      peakReaderBytes: 0,
    },
    undefined,
  );
  for (let n = 0; n < 10 && !wiped(early); n++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(wiped(early)).toBe(true);
});
