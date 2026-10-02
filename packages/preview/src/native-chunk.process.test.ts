import { EventEmitter } from "node:events";
import { afterEach, expect, test } from "vitest";
import { attachPreviewRelay } from "./index.ts";
import { openPreviewProxy, type PreviewSocket } from "./transport.ts";
import { channelPair, serve } from "./test-support.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

test.each(["oversized", "overlapping"])(
  "a %s native chunk resets its stream and leaves capacity for a real HTTP response",
  async (mode) => {
    const upstream = await serve((_req, res) => res.end("replacement works"));
    cleanup.push(upstream.close);
    const channels = channelPair();
    const host = attachPreviewRelay({
      channel: channels.b,
      maxStreams: 1,
      allowPort: async (port) => port === upstream.port,
    });
    cleanup.push(host.close);
    let reset: (() => void) | undefined;
    const rejected = new Promise<void>((resolve) => {
      reset = resolve;
    });
    let release: (() => void) | undefined;
    const writer = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accept: ((socket: PreviewSocket) => void) | undefined;
    const proxy = await openPreviewProxy({
      port: upstream.port,
      maxStreams: 1,
      channel: {
        ...channels.a,
        async send(frame) {
          const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
          if (id === 1 && frame[1] === 6) reset?.();
          await channels.a.send(frame);
          if (id === 1 && frame[1] === 3) await writer;
        },
      },
      runtime: {
        async listen({ openSocket }) {
          accept = openSocket;
          return { url: "http://native.localhost:1234", close: async () => {} };
        },
      },
    });
    cleanup.push(proxy.close);
    cleanup.push(() => {
      release?.();
    });
    const invalid = new EventEmitter();
    let delivered = false,
      destroyed = false;
    accept?.({
      readableLength: 0,
      writableLength: 0,
      on: invalid.on.bind(invalid),
      once: invalid.once.bind(invalid),
      pause() {},
      resume() {
        if (delivered) return;
        delivered = true;
        if (mode === "oversized") invalid.emit("data", new Uint8Array(262_145));
        else {
          invalid.emit("data", new Uint8Array([71]));
          invalid.emit("data", new Uint8Array([69]));
        }
      },
      destroy() {
        destroyed = true;
        invalid.emit("close");
      },
      end() {},
      write(_bytes, callback) {
        callback();
      },
    });
    await rejected;
    expect(destroyed).toBe(true);
    expect(proxy.stats().streams).toBe(0);
    expect(proxy.stats().pendingPayloadBytes).toBe(0);
    expect(proxy.stats().closed).toBe(false);
    const valid = new EventEmitter();
    let sent = false,
      response = "";
    let complete: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    accept?.({
      readableLength: 0,
      writableLength: 0,
      on: valid.on.bind(valid),
      once: valid.once.bind(valid),
      pause() {},
      resume() {
        if (sent) return;
        sent = true;
        valid.emit(
          "data",
          Buffer.from(
            `GET / HTTP/1.1\r\nHost: localhost:${upstream.port}\r\nConnection: close\r\n\r\n`,
          ),
        );
        valid.emit("end");
      },
      destroy() {
        valid.emit("close");
        complete?.();
      },
      end() {
        complete?.();
      },
      write(bytes, callback) {
        response += Buffer.from(bytes).toString();
        callback();
      },
    });
    await finished;
    expect(response).toContain("200 OK");
    expect(response).toContain("replacement works");
  },
);
