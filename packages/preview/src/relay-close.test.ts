import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { openPreviewProxy, type PreviewChannel } from "./transport.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
function control(kind: number, id: number) {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, kind);
  view.setUint32(4, id);
  return bytes;
}

test.each(["credit", "writer"])(
  "closing a real loopback socket blocked on %s releases capacity for the next connection",
  async (mode) => {
    let receive: ((bytes: Uint8Array) => void) | undefined;
    let finishClose: (() => void) | undefined;
    let channelClosed = false;
    let pendingChunk: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      pendingChunk = resolve;
    });
    let replacementOpened: (() => void) | undefined;
    const reopened = new Promise<void>((resolve) => {
      replacementOpened = resolve;
    });
    const resets: number[] = [];
    let releaseWriter: (() => void) | undefined;
    const writer = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let transportBytes = 0;
    const sockets = new Set<Socket>();
    let accepted: Socket | undefined;
    const channel: PreviewChannel = {
      get bufferedBytes() {
        return transportBytes;
      },
      async send(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const id = view.getUint32(4);
        if (bytes[1] === 1) {
          receive?.(control(2, id));
          if (id === 2) replacementOpened?.();
        }
        if (bytes[1] === 6) resets.push(id);
        if (mode === "writer" && bytes[1] === 3) {
          transportBytes = bytes.length;
          await writer;
          transportBytes = 0;
        }
        // The remote consumer never returns CREDIT for DATA.
      },
      close() {
        channelClosed = true;
        finishClose?.();
      },
      subscribe(onFrame, onClose) {
        receive = onFrame;
        finishClose = onClose;
        return () => {
          receive = undefined;
          finishClose = undefined;
        };
      },
    };
    const proxy = await openPreviewProxy({
      channel,
      port: 3000,
      maxStreams: 1,
      runtime: {
        async listen({ openSocket }) {
          const server = createServer({ allowHalfOpen: true }, (socket) => {
            accepted = socket;
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            openSocket(socket);
            let seen = 0;
            socket.on("data", (bytes) => {
              seen += bytes.length;
              if (mode === "writer" || seen > 262_144) pendingChunk?.();
            });
          });
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Missing loopback address");
          return {
            url: `http://localhost:${address.port}`,
            async close() {
              for (const socket of sockets) socket.destroy();
              await new Promise<void>((resolve) => server.close(() => resolve()));
            },
          };
        },
      },
    });
    cleanup.push(proxy.close);
    cleanup.push(() => {
      releaseWriter?.();
    });
    const client = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    cleanup.push(() => {
      client.destroy();
    });
    await once(client, "connect");
    client.write(Buffer.alloc(327_680, 1));
    await blocked;
    expect(proxy.stats().pendingPayloadBytes).toBeGreaterThan(0);
    expect(proxy.stats().bufferedBytes).toBeGreaterThanOrEqual(proxy.stats().pendingPayloadBytes);
    if (mode === "writer") {
      expect(proxy.stats().pendingFrameBytes).toBeGreaterThan(0);
      expect(proxy.stats().channelBufferedBytes).toBe(transportBytes);
    }
    if (!accepted) throw new Error("Missing accepted socket");
    const closed = once(accepted, "close");
    accepted.destroy();
    await closed;
    expect(proxy.stats().streams).toBe(0);
    expect(proxy.stats().pendingPayloadBytes).toBe(0);
    if (mode === "credit") expect(proxy.stats().bufferedBytes).toBe(0);
    expect(channelClosed).toBe(false);
    expect(resets).toContain(1);
    const next = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    cleanup.push(() => {
      next.destroy();
    });
    await once(next, "connect");
    await reopened;
    expect(proxy.stats().streams).toBe(1);
  },
);
