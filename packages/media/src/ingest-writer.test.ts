import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { decodeMediaFrame, type MediaFrame } from "./frame.ts";
import { IngestWriter } from "./ingest-writer.ts";

/** ace-media's ingest socket, as far as a producer can tell: frames read whole, in order. */
async function ingest() {
  const directory = mkdtempSync(join(tmpdir(), "ace-ingest-"));
  const path = join(directory, "i.sock");
  const received: MediaFrame[] = [];
  let ended = false;
  let peer: Socket | undefined;
  let buffer = Buffer.alloc(0);
  const server = createServer((socket) => {
    peer = socket;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const total = buffer.readUInt16BE(6) + buffer.readUInt32BE(8);
        if (buffer.length < total) break;
        received.push(decodeMediaFrame(new Uint8Array(buffer.subarray(0, total))));
        buffer = buffer.subarray(total);
      }
    });
    socket.on("end", () => void (ended = true));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  onTestFinished(() => {
    peer?.destroy();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    received,
    ended: () => ended,
    pause: () => peer?.pause(),
    resume: () => peer?.resume(),
    drop: () => peer?.destroy(),
    connected: () => peer !== undefined,
  };
}

async function until(condition: () => boolean): Promise<void> {
  const end = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function unit(mark: number, keyframe: boolean, bytes = 16): MediaFrame {
  return {
    kind: 1,
    flags: keyframe ? 1 : 0,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 0,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array(bytes).fill(mark),
  };
}

it("the hello goes first, units follow in order, and a finish writes them all, then the end frame, before the connection ends", async () => {
  const server = await ingest();
  const token = new Uint8Array(32).fill(7);
  const closed: string[] = [];
  const writer = new IngestWriter({
    socket: server.path,
    token,
    onClosed: () => void closed.push("closed"),
    onKeyframe: () => {},
  });
  expect([...token]).toEqual(Array.from({ length: 32 }, () => 0));
  for (const mark of [1, 2, 3]) writer.write(unit(mark, mark === 1));
  writer.finish();
  expect(writer.write(unit(4, false))).toBe(false);
  await until(server.ended);
  expect(server.received.map((frame) => frame.kind)).toEqual([5, 1, 1, 1, 4]);
  expect([...(server.received[0]?.payload ?? [])]).toEqual(Array.from({ length: 32 }, () => 7));
  expect(server.received.slice(1, 4).map((frame) => frame.payload[0])).toEqual([1, 2, 3]);
  expect(closed).toEqual([]);
});

it("a reader that falls behind gets deltas dropped to the next keyframe, asked for once", async () => {
  const server = await ingest();
  const keyframes: string[] = [];
  const writer = new IngestWriter({
    socket: server.path,
    token: new Uint8Array(32),
    onClosed: () => {},
    onKeyframe: () => void keyframes.push("key"),
    limit: 64 * 1024,
  });
  await until(server.connected);
  server.pause();
  writer.write(unit(1, true, 256 * 1024));
  // Over the limit: these deltas would decode against nothing once the backlog is cut.
  writer.write(unit(2, false));
  writer.write(unit(3, false));
  // The reader catches up; the next keyframe starts the stream again.
  server.resume();
  await until(() => server.received.length >= 2);
  writer.write(unit(4, true));
  writer.write(unit(5, false));
  writer.finish();
  await until(server.ended);
  expect(
    server.received.filter((frame) => frame.kind === 1).map((frame) => frame.payload[0]),
  ).toEqual([1, 4, 5]);
  expect(keyframes).toEqual(["key"]);
});

it("ace-media closing the connection is reported once, and nothing more is taken", async () => {
  const server = await ingest();
  const closed: string[] = [];
  const writer = new IngestWriter({
    socket: server.path,
    token: new Uint8Array(32),
    onClosed: () => void closed.push("closed"),
    onKeyframe: () => {},
  });
  await until(server.connected);
  server.drop();
  await until(() => closed.length > 0);
  expect(writer.write(unit(1, true))).toBe(false);
  expect(closed).toEqual(["closed"]);
});

it("a keyframe that won't fit waits for the reader to drain, and only the newest one goes", async () => {
  const server = await ingest();
  const writer = new IngestWriter({
    socket: server.path,
    token: new Uint8Array(32),
    onClosed: () => {},
    onKeyframe: () => {},
    limit: 64 * 1024,
  });
  await until(server.connected);
  server.pause();
  writer.write(unit(1, true, 256 * 1024));
  // Past the budget: keyframes count too. Only the newest waits; deltas behind it are dropped.
  writer.write(unit(2, true));
  writer.write(unit(3, false));
  writer.write(unit(4, true));
  writer.write(unit(5, false));
  server.resume();
  await until(() => server.received.length >= 3);
  writer.write(unit(6, false));
  writer.finish();
  await until(server.ended);
  expect(
    server.received.filter((frame) => frame.kind === 1).map((frame) => frame.payload[0]),
  ).toEqual([1, 4, 6]);
});

it("a reader that doesn't drain within the drain limit has its path closed, reported as a cut", async () => {
  const server = await ingest();
  const closed: string[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const writer = new IngestWriter({
    socket: server.path,
    token: new Uint8Array(32),
    onClosed: () => void closed.push("closed"),
    onKeyframe: () => {},
    limit: 64 * 1024,
    after: (ms, run) => {
      timers.push({ ms, run });
      return () => {};
    },
  });
  await until(server.connected);
  server.pause();
  writer.write(unit(1, true, 256 * 1024));
  writer.write(unit(2, true));
  expect(timers.map((timer) => timer.ms)).toEqual([2_000]);
  timers[0]?.run();
  expect(closed).toEqual(["closed"]);
  expect(writer.write(unit(3, true))).toBe(false);
});

/** A writer whose socket never reports `drain`: its high-water mark is above every backlog. */
function roomyWriter(path: string, extra: Partial<ConstructorParameters<typeof IngestWriter>[0]>) {
  return new IngestWriter({
    socket: path,
    token: new Uint8Array(32),
    onClosed: () => {},
    onKeyframe: () => {},
    limit: 64 * 1024,
    connect: (socket) => {
      // Node's sockets take a stream's high-water mark, though the net types don't list it.
      const options = { path: socket, writableHighWaterMark: 64 * 1024 * 1024 };
      return createConnection(options);
    },
    ...extra,
  });
}

it("a waiting keyframe goes once the backlog is written, even when the socket never says drain", async () => {
  const server = await ingest();
  const closed: string[] = [];
  const writer = roomyWriter(server.path, {
    onClosed: () => void closed.push("closed"),
    after: () => () => {},
  });
  await until(server.connected);
  server.pause();
  writer.write(unit(1, true, 1024 * 1024));
  writer.write(unit(2, true));
  server.resume();
  await until(() => server.received.some((frame) => frame.payload[0] === 2));
  expect(
    server.received.filter((frame) => frame.kind === 1).map((frame) => frame.payload[0]),
  ).toEqual([1, 2]);
  expect(closed).toEqual([]);
});

it("the drain limit looks at the real backlog: a socket that emptied is not cut", async () => {
  const server = await ingest();
  const closed: string[] = [];
  const timers: (() => void)[] = [];
  const writer = roomyWriter(server.path, {
    onClosed: () => void closed.push("closed"),
    after: (_ms, run) => {
      timers.push(run);
      return () => {};
    },
  });
  await until(server.connected);
  server.pause();
  writer.write(unit(1, true, 1024 * 1024));
  writer.write(unit(2, false));
  server.resume();
  await until(() => server.received.some((frame) => frame.payload[0] === 1));
  timers[0]?.();
  expect(closed).toEqual([]);
  expect(writer.write(unit(3, true))).toBe(true);
  writer.finish();
  await until(server.ended);
  expect(
    server.received.filter((frame) => frame.kind === 1).map((frame) => frame.payload[0]),
  ).toEqual([1, 3]);
});

it("a finish writes the waiting keyframe before the end frame", async () => {
  const server = await ingest();
  const writer = roomyWriter(server.path, {});
  await until(server.connected);
  server.pause();
  writer.write(unit(1, true, 1024 * 1024));
  writer.write(unit(2, true));
  writer.finish();
  server.resume();
  await until(server.ended);
  expect(server.received.map((frame) => [frame.kind, frame.payload[0]])).toEqual([
    [5, 0],
    [1, 1],
    [1, 2],
    [4, undefined],
  ]);
});

it("a finish whose waiting keyframe can't go within the drain limit is a cut, not a clean end", async () => {
  const server = await ingest();
  const closed: string[] = [];
  const timers: (() => void)[] = [];
  const writer = roomyWriter(server.path, {
    onClosed: () => void closed.push("closed"),
    after: (_ms, run) => {
      timers.push(run);
      return () => {};
    },
  });
  await until(server.connected);
  server.pause();
  writer.write(unit(1, true, 1024 * 1024));
  writer.write(unit(2, true));
  writer.finish();
  for (const run of timers) run();
  expect(closed).toEqual(["closed"]);
  server.resume();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(server.received.some((frame) => frame.kind === 4)).toBe(false);
});

it("a socket that fails while the writer is made reports its close after the caller holds the writer", async () => {
  const closes: { reason: string; held: boolean }[] = [];
  let writer: IngestWriter | undefined;
  const made = new IngestWriter({
    socket: "/nonexistent/ingest.sock",
    token: new Uint8Array(32),
    onClosed: (reason) => void closes.push({ reason: reason ?? "", held: writer !== undefined }),
    onKeyframe: () => {},
    connect: () => {
      const socket = createConnection("/nonexistent/ingest.sock");
      socket.on("error", () => {});
      socket.destroy();
      return socket;
    },
  });
  writer = made;
  await until(() => closes.length > 0);
  expect(closes).toEqual([{ reason: "destroyed", held: true }]);
  expect(made.closed).toBe(true);
});
