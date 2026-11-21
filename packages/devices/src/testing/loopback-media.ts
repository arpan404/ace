import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMediaFrame } from "@ace/media/frame";
import type { IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import type { DeviceMedia } from "../media-paths.ts";

/**
 * ace-media for device tests without the binary: a real ingest socket that takes each
 * producer's hello and units and hands every video unit straight back as egress. Each attach is
 * pointed at the socket at once, with a token of its own, as ace-media does once it has the
 * source. Video reaches a capture or a screen session only this way, as in the daemon.
 */
export async function loopbackMedia(
  cleanup: (() => Promise<void> | void)[],
): Promise<DeviceMedia & { add: DeviceMedia["attach"]; pictures: Buffer[] }> {
  const dir = await mkdtemp(join(tmpdir(), "ace-loopback-"));
  const socket = join(dir, "ingest.sock");
  const byToken = new Map<string, { producer: IngestProducer; path: string }>();
  let paths = 0;
  /** JPEG pictures a source's ingest carried for ace-media to encode (a JPEG-only screen's). */
  const pictures: Buffer[] = [];
  const open = new Set<import("node:net").Socket>();
  const server: Server = createServer((connection) => {
    open.add(connection);
    connection.on("close", () => open.delete(connection));
    let buffered = Buffer.alloc(0);
    let owner: { producer: IngestProducer; path: string } | undefined;
    let sequence = 0;
    connection.on("error", () => {});
    connection.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 12) {
        const length = buffered.readUInt16BE(6) + buffered.readUInt32BE(8);
        if (buffered.length < length) return;
        const frame = decodeMediaFrame(buffered.subarray(0, length));
        buffered = buffered.subarray(length);
        if (frame.kind === 5) owner = byToken.get(Buffer.from(frame.payload).toString("hex"));
        else if (owner && frame.kind === 3) pictures.push(Buffer.from(frame.payload));
        else if (owner && frame.kind === 1)
          owner.producer.consumers.deliver({
            source: owner.path,
            sequence: sequence++,
            gap: false,
            frame,
          });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(async () => {
    for (const connection of open) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const attach = (producer: IngestProducer): IngestSource => {
    const token = new Uint8Array(randomBytes(32));
    const path = `loopback-${++paths}`;
    byToken.set(Buffer.from(token).toString("hex"), { producer, path });
    setTimeout(() => {
      void producer
        .point({ url: "", socket, token: token.slice(), epoch: 0, path })
        .catch(() => {});
    }, 0);
    return {
      streaming: () => true,
      reconnect: () => {},
      codecs: () => {},
      encodes: () => {},
      key: () => {},
      picture: () => false,
      close: () => void byToken.delete(Buffer.from(token).toString("hex")),
    };
  };
  // Devices attach their producers; a screen manager adds them.
  return { attach, add: attach, pictures };
}
