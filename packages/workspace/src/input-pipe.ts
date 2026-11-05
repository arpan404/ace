import { closeSync } from "node:fs";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pipeDescriptors } from "./descriptor.ts";

/** Feeds one pipe's write end from the event loop, without ever blocking it. */
interface PipeWriter {
  feed(input: AsyncIterable<Buffer>): Promise<void>;
  dispose(): Promise<void>;
}

interface BunFileSink {
  write(chunk: Uint8Array): number | Promise<number>;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
}
interface BunFiles {
  file(fd: number): { writer(): BunFileSink };
}
function hasFile(value: unknown): value is BunFiles {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "file") === "function"
  );
}
function bunFiles(): BunFiles | undefined {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  return hasFile(bun) ? bun : undefined;
}

// libuv polls the non-blocking descriptor and applies backpressure.
function socketWriter(fd: number): PipeWriter {
  const stream = new Socket({ fd, readable: false, writable: true });
  return {
    feed: (input) => pipeline(Readable.from(input), stream),
    async dispose() {
      if (stream.closed) return;
      const closed = new Promise<void>((resolve) => stream.once("close", resolve));
      stream.destroy();
      await closed;
    },
  };
}

// Bun's net.Socket writes a pipe descriptor without polling it: a blocking one freezes the whole
// process once the pipe is full, a non-blocking one fails with EAGAIN. Its FileSink polls it.
// A pending sink write ends only when the reader drains or closes the pipe (EPIPE), so dispose
// waits for the feed: callers release the reader (the child exits) before disposing.
function sinkWriter(bun: BunFiles, fd: number): PipeWriter {
  const sink = bun.file(fd).writer();
  let feeding: Promise<void> = Promise.resolve();
  let disposed = false;
  let open = true;
  // Ending the input closes the write end, so the reader sees end of file.
  async function close() {
    if (!open) return;
    open = false;
    try {
      await sink.end();
    } catch {
      // A broken pipe has nothing left to flush; the descriptor still needs closing.
    }
    // FileSink leaves a descriptor it was given open.
    closeSync(fd);
  }
  return {
    feed(input) {
      feeding = (async () => {
        try {
          for await (const chunk of input) {
            if (disposed) return;
            await sink.write(chunk);
            await sink.flush();
          }
        } finally {
          await close();
        }
      })();
      return feeding;
    },
    async dispose() {
      disposed = true;
      await feeding.catch(() => undefined);
      await close();
    },
  };
}

/** A real POSIX pipe can be reopened via /dev/fd on Linux as well as macOS. */
export function inputPipe() {
  const pair = pipeDescriptors();
  let writer: PipeWriter;
  try {
    const bun = bunFiles();
    writer = bun ? sinkWriter(bun, pair.write) : socketWriter(pair.write);
  } catch (error) {
    closeSync(pair.read);
    closeSync(pair.write);
    throw error;
  }
  let readerOpen = true;
  function releaseReader() {
    if (!readerOpen) return;
    readerOpen = false;
    closeSync(pair.read);
  }
  return {
    fd: pair.read,
    feed: (input: AsyncIterable<Buffer>) => writer.feed(input),
    releaseReader,
    async dispose() {
      releaseReader();
      await writer.dispose();
    },
  };
}
export type InputPipe = ReturnType<typeof inputPipe>;
