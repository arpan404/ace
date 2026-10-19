import { describe, expect, it } from "vitest";
import {
  ChunkedFile,
  fetchChunked,
  retryDelay,
  TransferError,
  type ChunkAsk,
  type ChunkReply,
  type TransferIo,
} from "./download-transfer.ts";

const file = Uint8Array.from({ length: 1000 }, (_, index) => index % 251);

class Offline extends Error {}

/** A daemon serving `bytes`, which fails the reads named in `failAt` (by call number) once. */
function daemon(bytes: Uint8Array, options: { failAt?: number[]; validator?: () => string } = {}) {
  const asks: ChunkAsk[] = [];
  const waits: number[] = [];
  let calls = 0;
  const io: TransferIo = {
    async read(ask) {
      calls++;
      asks.push(ask);
      if (options.failAt?.includes(calls)) throw new Offline("connection dropped");
      const validator = options.validator?.() ?? "v1";
      if (ask.validator !== undefined && ask.validator !== validator)
        throw new Error("The download changed; start it again");
      const chunk = bytes.subarray(ask.offset, ask.offset + ask.length);
      return {
        offset: ask.offset,
        bytes: chunk,
        size: bytes.length,
        validator,
        done: ask.offset + chunk.length === bytes.length,
      } satisfies ChunkReply;
    },
    retryable: (error) => error instanceof Offline,
    async wait(ms) {
      waits.push(ms);
    },
  };
  return { io, asks, waits };
}

describe("fetching a download in chunks", () => {
  it("arrives whole, in chunks of the asked size", async () => {
    const { io, asks } = daemon(file);
    const progress: number[] = [];
    const bytes = await fetchChunked(io, new ChunkedFile(10_000, 300), {
      onProgress: (received) => progress.push(received),
    });
    expect(bytes).toEqual(file);
    expect(asks.map((ask) => ask.offset)).toEqual([0, 300, 600, 900]);
    expect(progress).toEqual([300, 600, 900, 1000]);
  });

  it("resumes from where it stopped after the connection drops, never from the start", async () => {
    const { io, asks, waits } = daemon(file, { failAt: [3, 4] });
    const bytes = await fetchChunked(io, new ChunkedFile(10_000, 300));
    expect(bytes).toEqual(file);
    expect(asks.map((ask) => ask.offset)).toEqual([0, 300, 600, 600, 600, 900]);
    // Every read after the first carries the file's validator, so the daemon can refuse a change.
    expect(asks.slice(1).every((ask) => ask.validator === "v1")).toBe(true);
    expect(waits).toEqual([retryDelay(1), retryDelay(2)]);
  });

  it("gives up after too many failed reads in a row", async () => {
    const { io } = daemon(file, { failAt: [2, 3, 4] });
    await expect(fetchChunked(io, new ChunkedFile(10_000, 300), { maxRetries: 2 })).rejects.toThrow(
      "connection dropped",
    );
  });

  it("stops at once on a failure that asking again won't fix", async () => {
    let version = "v1";
    const { io, asks } = daemon(file, { validator: () => version });
    const reading = fetchChunked(
      {
        ...io,
        read: async (ask) => {
          const reply = await io.read(ask);
          version = "v2";
          return reply;
        },
      },
      new ChunkedFile(10_000, 300),
    );
    await expect(reading).rejects.toThrow("changed");
    expect(asks).toHaveLength(2);
  });

  it("refuses a file larger than this device takes before keeping any of it", async () => {
    const { io, asks } = daemon(file);
    await expect(fetchChunked(io, new ChunkedFile(999, 300))).rejects.toThrow(TransferError);
    expect(asks).toHaveLength(1);
  });

  it("an empty file arrives in one read", async () => {
    const { io } = daemon(new Uint8Array());
    expect(await fetchChunked(io, new ChunkedFile(10, 300))).toEqual(new Uint8Array());
  });

  it("a stop from the person ends the transfer", async () => {
    const { io } = daemon(file, { failAt: [2] });
    const controller = new AbortController();
    const reading = fetchChunked(
      { ...io, wait: async () => controller.abort(new Error("stopped")) },
      new ChunkedFile(10_000, 300),
      { signal: controller.signal },
    );
    await expect(reading).rejects.toThrow("stopped");
  });
});

const reply = (offset: number, length: number, overrides: Partial<ChunkReply> = {}) => ({
  offset,
  bytes: file.subarray(offset, offset + length),
  size: file.length,
  validator: "v1",
  done: offset + length === file.length,
  ...overrides,
});

describe("a chunked file", () => {
  it("refuses a chunk that isn't the next one", () => {
    const chunks = new ChunkedFile(10_000, 300);
    chunks.accept(reply(0, 300));
    expect(() => chunks.accept(reply(600, 300))).toThrow("out of order");
  });

  it("refuses a chunk from a file whose size changed", () => {
    const chunks = new ChunkedFile(10_000, 300);
    chunks.accept(reply(0, 300));
    expect(() => chunks.accept(reply(300, 300, { size: 2000, done: false }))).toThrow("changed");
  });

  it("refuses a chunk that says it is the last before the file's end", () => {
    const chunks = new ChunkedFile(10_000, 300);
    expect(() => chunks.accept(reply(0, 300, { done: true }))).toThrow("end");
  });

  it("asks only for what is left of the file", () => {
    const chunks = new ChunkedFile(10_000, 300);
    chunks.accept(reply(0, 300));
    chunks.accept(reply(300, 300));
    chunks.accept(reply(600, 300));
    expect(chunks.next()).toEqual({ offset: 900, length: 100, validator: "v1" });
  });
});
