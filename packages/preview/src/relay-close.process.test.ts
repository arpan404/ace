import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { previewSocket } from "./node-socket.ts";
import { createMux } from "./relay-mux.ts";
import { decodeFrame, encodeFrame, kinds } from "./relay-wire.ts";
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
    const ends: number[] = [];
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
        if (bytes[1] === 5) ends.push(id);
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
            // As the Node runtime does: Bun reads more than one window at a time.
            openSocket(previewSocket(socket));
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
    // Closing the accepted socket with unread bytes can reset its peer.
    client.on("error", () => {});
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
    next.on("error", () => {});
    cleanup.push(() => {
      next.destroy();
    });
    await once(next, "connect");
    await reopened;
    expect(proxy.stats().streams).toBe(1);
    // An aborted transfer is never reported to the peer as complete.
    expect(ends).toEqual([]);
  },
);

test("a socket that closes while its last oversized read waits for credit still ends cleanly", async () => {
  // The peer half-closes first, so the socket closes as soon as its own end is read, while the
  // adapter still holds most of the final read behind credit the peer hasn't returned yet.
  let receive: ((frame: Uint8Array) => void) | undefined;
  let creditOpen = false;
  let owedCredit = 0;
  const delivered: Uint8Array[] = [];
  const after: string[] = [];
  let settle: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const credit = (id: number, value: number) => receive?.(encodeFrame(kinds.credit, id, value));
  const mux = createMux({
    maxStreams: 1,
    channel: {
      async send(bytes) {
        const frame = decodeFrame(bytes);
        if (frame.kind === kinds.open) {
          receive?.(encodeFrame(kinds.ready, frame.id));
          receive?.(encodeFrame(kinds.end, frame.id));
        } else if (frame.kind === kinds.data) {
          delivered.push(Buffer.from(frame.data));
          if (creditOpen) credit(frame.id, frame.value);
          else owedCredit += frame.value;
        } else if (frame.kind === kinds.end || frame.kind === kinds.reset) {
          after.push(frame.kind === kinds.end ? "end" : "reset");
          settle?.();
        }
      },
      close() {},
      subscribe(onFrame) {
        receive = onFrame;
        return () => {
          receive = undefined;
        };
      },
    },
  });
  cleanup.push(mux.close);
  const server = createServer({ allowHalfOpen: true });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const accepted = once(server, "connection") as Promise<[Socket]>;
  const client = connect(address.port, "127.0.0.1");
  client.on("error", () => {});
  cleanup.push(() => {
    client.destroy();
  });
  const [raw] = await accepted;
  raw.pause();
  // Bun reads up to 512 KiB at once: put such a read back as the socket's last.
  const last = Buffer.from(Array.from({ length: 600_000 }, (_, i) => i % 251));
  raw.unshift(last);
  client.end();
  const rawClosed = once(raw, "close");
  mux.open(previewSocket(raw), 3000);

  await rawClosed;
  expect(Buffer.concat(delivered).byteLength).toBeLessThan(last.byteLength);
  creditOpen = true;
  credit(1, owedCredit);
  await settled;
  await new Promise((resolve) => setImmediate(resolve));

  expect(Buffer.concat(delivered)).toEqual(last);
  expect(after).toEqual(["end"]);
  expect(mux.stats().streams).toBe(0);
});
