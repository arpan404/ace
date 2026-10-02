import { EventEmitter } from "node:events";
import { openPreviewProxy, type PreviewSocket } from "../src/transport.ts";

/** Measure mux cleanup at a controlled native-I/O boundary, with no timing gate. */
export async function benchmarkCreditExhaustedCloses(count: number): Promise<number> {
  let receive: ((frame: Uint8Array) => void) | undefined;
  let accept: ((socket: PreviewSocket) => void) | undefined;
  let blocked: (() => void) | undefined;
  const chunk = new Uint8Array(65_536);
  const proxy = await openPreviewProxy({
    port: 3000,
    maxStreams: 1,
    channel: {
      async send(frame) {
        if (frame[1] !== 1) return;
        const ready = new Uint8Array(12);
        ready.set(frame.subarray(0, 8));
        ready[1] = 2;
        receive?.(ready);
      },
      subscribe(onFrame) {
        receive = onFrame;
        return () => {
          receive = undefined;
        };
      },
      close() {},
    },
    runtime: {
      async listen({ openSocket }) {
        accept = openSocket;
        return { url: "http://native.localhost:1234", close: async () => {} };
      },
    },
  });
  let peak = process.memoryUsage().rss;
  try {
    for (let n = 0; n < count; n++) {
      const events = new EventEmitter();
      let delivered = 0,
        destroyed = false;
      const exhausted = new Promise<void>((resolve) => {
        blocked = resolve;
      });
      const socket: PreviewSocket = {
        readableLength: 0,
        writableLength: 0,
        on: events.on.bind(events),
        once: events.once.bind(events),
        pause() {},
        resume() {
          delivered++;
          events.emit("data", chunk);
          if (delivered === 5) blocked?.();
        },
        destroy() {
          if (!destroyed) {
            destroyed = true;
            events.emit("close");
          }
        },
        end() {},
        write(_bytes, callback) {
          callback();
        },
      };
      accept?.(socket);
      await exhausted;
      socket.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const stats = proxy.stats();
      if (stats.streams !== 0 || stats.bufferedBytes !== 0)
        throw new Error("Relay retained closed work");
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    return peak;
  } finally {
    await proxy.close();
  }
}
