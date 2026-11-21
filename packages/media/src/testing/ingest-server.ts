import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMediaFrame, type MediaFrame } from "../frame.ts";

/**
 * ace-media's ingest socket as a producer sees it, for tests without the binary: a real unix
 * socket whose frames are read whole and kept in order (`received`). `pause` stops reading, as a
 * busy ace-media would; `close` ends it.
 */
export async function ingestServer() {
  const directory = mkdtempSync(join(tmpdir(), "ace-ingest-"));
  const path = join(directory, "i.sock");
  const received: MediaFrame[] = [];
  let peer: Socket | undefined;
  let buffer = Buffer.alloc(0);
  const server = createServer((socket) => {
    peer = socket;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const total = buffer.readUInt16BE(6) + buffer.readUInt32BE(8);
        if (buffer.length < total) break;
        received.push(decodeMediaFrame(new Uint8Array(buffer.subarray(0, total))));
        buffer = buffer.subarray(total);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    received,
    pause: () => peer?.pause(),
    resume: () => peer?.resume(),
    connected: () => peer !== undefined,
    close: () => {
      peer?.destroy();
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
