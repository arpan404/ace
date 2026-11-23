import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMediaFrame, type MediaFrame } from "@ace/media/frame";
import type { IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import type { DeviceMedia } from "../media-paths.ts";
import { ScrcpyVideoUnits } from "../scrcpy-video.ts";
import { VideoStreamReader } from "../scrcpy-protocol.ts";

/**
 * ace-media for device tests without the binary: a real ingest socket that takes each
 * producer's hello and units and hands every video unit straight back as egress. Each attach is
 * pointed at the socket at once, with a token of its own, as ace-media does once it has the
 * source. Video reaches a capture or a screen session only this way, as in the daemon.
 *
 * With `ACE_SCRCPY_VIDEO=media` the daemon opens a scrcpy source with the tunnel's real port
 * and reads nothing itself: this fake plays ace-media's half instead, dialling the tunnel,
 * greeting after the dummy byte, reading the name and codec once the daemon connects control,
 * then streaming the units. A control-only open (port 0) stays on the ingest path.
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
    for (const scrcpy of scrcpyReaders.splice(0)) scrcpy.close();
    for (const connection of open) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const attach = (producer: IngestProducer): IngestSource => {
    if (producer.origin.kind === "scrcpy" && producer.origin.port !== 0)
      return attachScrcpy(producer, producer.origin.port);
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
      close: () => void byToken.delete(Buffer.from(token).toString("hex")),
    };
  };
  /** ace-media's own scrcpy readers, one per D1 source, closed with the fake. */
  const scrcpyReaders: { close(): void }[] = [];
  /** D1: ace-media's half of the handshake, against the fake device's tunnel. */
  function attachScrcpy(producer: IngestProducer, port: number): IngestSource {
    const path = `loopback-${++paths}`;
    let connection: Socket | undefined;
    let closed = false;
    let generation = 0;
    let control: (() => void) | undefined;
    const fail = (reason: string) => {
      if (!closed) producer.refused?.(reason);
    };
    const run = async (gen: number, dialPort: number): Promise<void> => {
      const dialled = await dial(dialPort);
      if (dialled === undefined || gen !== generation || closed) {
        dialled?.destroy();
        return;
      }
      connection = dialled;
      const stream = new SocketReader(dialled, () => {
        if (gen === generation) fail("scrcpy-closed");
      });
      // The dummy byte, before anything else.
      const dummy = await stream.read(1).catch(() => undefined);
      if (dummy === undefined || gen !== generation || closed) return;
      producer.greeted?.({ path, dial: gen });
      // The name and codec follow once the daemon connects control.
      const connected = await new Promise<boolean>((resolve, reject) => {
        control = () => resolve(true);
        if (gen !== generation || closed) reject(new Error("closed"));
      }).then(
        () => true,
        () => false,
      );
      control = undefined;
      if (!connected || gen !== generation || closed) return;
      const meta = await stream.read(68).catch(() => undefined);
      if (meta === undefined || gen !== generation || closed) return;
      if (meta.readUInt32BE(64) !== 0x68323634) {
        fail("scrcpy-closed");
        return;
      }
      const end = meta.subarray(0, 64).indexOf(0);
      producer.ready?.(meta.subarray(0, end < 0 ? 64 : end).toString("utf8"));
      // The stream: each unit straight back as egress, as ace-media's reader reports it.
      let sequence = 0;
      const video = new VideoStreamReader((event) => {
        try {
          units.push(event);
        } catch {
          fail("scrcpy-closed");
        }
      });
      const units = new ScrcpyVideoUnits(
        (unit) => {
          if (gen !== generation || closed) return;
          const frame: MediaFrame = {
            kind: 1,
            flags: unit.keyframe ? 1 : 0,
            ageUs: 0,
            width: unit.width,
            height: unit.height,
            displayWidth: unit.width,
            displayHeight: unit.height,
            scale: 1000,
            rotation: 0,
            codec: 1,
            encode: 0,
            epoch: 0,
            codecString: unit.keyframe ? unit.videoCodec : "",
            description: new Uint8Array(0),
            extension: new Uint8Array(0),
            payload: unit.payload,
          };
          producer.consumers.deliver({ source: path, sequence: sequence++, gap: false, frame });
        },
        () => {},
      );
      // The handshake already read the codec id: the reader still needs it first.
      try {
        video.push(meta.subarray(64));
      } catch {
        fail("scrcpy-closed");
        return;
      }
      for (;;) {
        const head = await stream.read(12).catch(() => undefined);
        if (head === undefined || gen !== generation || closed) return;
        // A session packet carries no payload; a media packet's size follows its header.
        let chunk = head;
        if ((head[0] ?? 0) < 0x80) {
          const size = head.readUInt32BE(8);
          if (size > 8 * 1024 * 1024) {
            fail("scrcpy-closed");
            return;
          }
          const payload = size ? await stream.read(size).catch(() => undefined) : Buffer.alloc(0);
          if (payload === undefined || gen !== generation || closed) return;
          chunk = Buffer.concat([head, payload]);
        }
        try {
          video.push(chunk);
        } catch {
          fail("scrcpy-closed");
          return;
        }
      }
    };
    const dial = (dialPort: number): Promise<Socket | undefined> =>
      new Promise((resolve) => {
        const connecting = new Socket();
        connecting.once("connect", () => {
          connecting.off("error", failed);
          connecting.on("error", () => {});
          resolve(connecting);
        });
        const failed = () => {
          connecting.destroy();
          setTimeout(() => {
            if (!closed) resolve(dial(dialPort));
            else resolve(undefined);
          }, 10);
        };
        connecting.once("error", failed);
        connecting.connect(dialPort, "127.0.0.1");
      });
    void run(generation, port);
    // The source is up: point the capture at it now, as the daemon's own sources do once
    // ace-media reports them starting. Synchronous, so the merge moves onto the path before
    // the handshake's first unit can arrive.
    void producer
      .point({ url: "", socket: "", token: new Uint8Array(32), epoch: 0, path })
      .catch(() => {});
    const source: IngestSource = {
      streaming: () => !closed,
      reconnect: () => {},
      codecs: () => {},
      encodes: () => {},
      key: () => {},
      controlConnected: (greeting) => {
        if (greeting.path === path && greeting.dial === generation) control?.();
      },
      dial: (host, dialPort) => {
        if (host !== "127.0.0.1" && host !== "localhost") {
          fail("scrcpy-closed");
          return;
        }
        const gen = ++generation;
        connection?.destroy();
        connection = undefined;
        control?.();
        control = undefined;
        void run(gen, dialPort);
      },
      close: () => {
        if (closed) return;
        closed = true;
        generation++;
        connection?.destroy();
        connection = undefined;
        control?.();
        control = undefined;
      },
    };
    scrcpyReaders.push(source);
    return source;
  }
  // Devices attach their producers; a screen manager adds them.
  const media: DeviceMedia & { add: DeviceMedia["attach"]; pictures: Buffer[] } = {
    attach,
    add: attach,
    pictures,
    speaks: () => true,
  };
  return media;
}

/** Buffered exact reads off a socket: leftover bytes belong to the next read. */
class SocketReader {
  #buffered = Buffer.alloc(0);
  #waiters: {
    count: number;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
  }[] = [];
  #onFailed: () => void;

  constructor(connection: Socket, onFailed: () => void) {
    this.#onFailed = onFailed;
    connection.on("data", (chunk: Buffer) => {
      this.#buffered = Buffer.concat([this.#buffered, chunk]);
      this.#pump();
    });
    connection.on("error", () => {});
    connection.on("close", () => this.#fail(new Error("socket closed")));
  }

  read(count: number): Promise<Buffer> {
    if (this.#buffered.length >= count) {
      const out = this.#buffered.subarray(0, count);
      this.#buffered = this.#buffered.subarray(count);
      return Promise.resolve(out);
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.#waiters.push({ count, resolve, reject });
    });
  }

  close(): void {
    this.#fail(new Error("reader closed"));
  }

  #pump(): void {
    while (this.#waiters.length && this.#buffered.length >= (this.#waiters[0]?.count ?? 0)) {
      const waiter = this.#waiters.shift();
      if (!waiter) return;
      const out = this.#buffered.subarray(0, waiter.count);
      this.#buffered = this.#buffered.subarray(waiter.count);
      waiter.resolve(out);
    }
  }

  #fail(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    this.#onFailed();
  }
}
