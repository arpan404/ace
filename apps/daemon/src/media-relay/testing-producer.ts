import { createConnection, type Socket } from "node:net";
import { encodeMediaFrame } from "@ace/media/frame";
import type { IngestProducer } from "@ace/media/ingest-sources";

/*
 * Test support: a tab producer that, once ace-media points it at its ingest socket, sends H.264
 * units at 60 fps with a keyframe every ten, as the video extension would.
 */

const frame = (kind: number, flags: number, payload: Uint8Array) =>
  encodeMediaFrame({
    kind,
    flags,
    ageUs: 0,
    width: kind === 5 ? 0 : 640,
    height: kind === 5 ? 0 : 400,
    displayWidth: kind === 5 ? 0 : 640,
    displayHeight: kind === 5 ? 0 : 400,
    scale: kind === 5 ? 0 : 1000,
    rotation: 0,
    codec: kind === 5 ? 0 : 1,
    encode: 0,
    epoch: 0,
    codecString: kind === 5 ? "" : "avc1.42E033",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload,
  });

export function tabProducer(threadId: string): IngestProducer & { stop(): void } {
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    socket?.destroy();
    socket = undefined;
  };
  return {
    source: "tab",
    kind: "tab",
    origin: { kind: "tab" },
    threadId,
    epoch: () => 0,
    consumers: { record: () => {}, still: () => {} },
    keyframe: () => {},
    stop,
    point: (address) => {
      stop();
      if (!address) return Promise.resolve();
      const connection = createConnection(address.socket);
      socket = connection;
      connection.on("error", () => {});
      connection.write(frame(5, 0, address.token.slice()));
      let n = 0;
      timer = setInterval(() => {
        const key = n % 10 === 0;
        connection.write(
          frame(1, key ? 1 : 0, new Uint8Array([0, 0, 0, 1, key ? 0x65 : 0x41, n++ & 0xff])),
        );
      }, 16);
      return Promise.resolve();
    },
  };
}
