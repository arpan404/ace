import { once } from "node:events";
import { createServer, connect, Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { previewSocket } from "./node-socket.ts";
import { createMux, gracefulDrainMs, systemTimer, type MuxTimer } from "./relay-mux.ts";
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

/** Fires timers when the test moves the clock, never on its own. */
function manualTimer() {
  let now = 0;
  const due = new Set<{ at: number; run: () => void }>();
  const timer: MuxTimer = (run, ms) => {
    const entry = { at: now + ms, run };
    due.add(entry);
    return () => due.delete(entry);
  };
  const advance = (ms: number) => {
    now += ms;
    for (const entry of due) {
      if (entry.at > now) continue;
      due.delete(entry);
      entry.run();
    }
  };
  return { timer, advance };
}

const turns = async (condition: () => boolean) => {
  for (let i = 0; i < 1000 && !condition(); i++)
    await new Promise((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error("Condition never held");
};

/**
 * The peer half-closes first, so the socket closes as soon as its own end is read, while the
 * adapter still holds most of its last oversized read behind credit the peer hasn't returned.
 */
async function closedWhileDraining() {
  let receive: ((frame: Uint8Array) => void) | undefined;
  let creditOpen = false;
  let owedCredit = 0;
  const delivered: Uint8Array[] = [];
  const after: string[] = [];
  const clock = manualTimer();
  const peer = (frame: Uint8Array) => receive?.(frame);
  const mux = createMux({
    maxStreams: 1,
    timer: clock.timer,
    channel: {
      async send(bytes) {
        const frame = decodeFrame(bytes);
        if (frame.kind === kinds.open) {
          peer(encodeFrame(kinds.ready, frame.id));
          peer(encodeFrame(kinds.end, frame.id));
        } else if (frame.kind === kinds.data) {
          delivered.push(Buffer.from(frame.data));
          if (creditOpen) peer(encodeFrame(kinds.credit, frame.id, frame.value));
          else owedCredit += frame.value;
        } else if (frame.kind === kinds.end || frame.kind === kinds.reset) {
          after.push(frame.kind === kinds.end ? "end" : "reset");
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
  const deliveredBytes = () => Buffer.concat(delivered).byteLength;
  expect(deliveredBytes()).toBeLessThan(last.byteLength);
  return {
    mux,
    last,
    delivered,
    after,
    clock,
    peer,
    deliveredBytes,
    /** Returns the credit owed so far; with `keepGoing`, returns all later credit at once. */
    credit(keepGoing: boolean) {
      creditOpen = keepGoing;
      const value = owedCredit;
      owedCredit = 0;
      peer(encodeFrame(kinds.credit, 1, value));
    },
  };
}

test("a socket that closes while its last oversized read waits for credit still ends cleanly", async () => {
  const drain = await closedWhileDraining();
  drain.credit(true);
  await turns(() => drain.after.length > 0 && drain.mux.stats().streams === 0);

  expect(Buffer.concat(drain.delivered)).toEqual(drain.last);
  expect(drain.after).toEqual(["end"]);
});

test("a closed stream whose peer stops returning credit is reset and frees its slot", async () => {
  const drain = await closedWhileDraining();
  drain.clock.advance(gracefulDrainMs - 1);
  expect(drain.mux.stats().streams).toBe(1);
  drain.clock.advance(1);
  await turns(() => drain.after.length > 0);

  expect(drain.after).toEqual(["reset"]);
  expect(drain.mux.stats().streams).toBe(0);
  await turns(() => drain.mux.stats().pendingPayloadBytes === 0);
});

test("a socket closed with bytes still held is reset at the deadline from its close, though credit keeps coming", async () => {
  const drain = await closedWhileDraining();
  const before = drain.deliveredBytes();
  drain.clock.advance(gracefulDrainMs - 1);
  // Credit late in the wait moves the held bytes on, but buys no time.
  drain.credit(false);
  await turns(() => drain.deliveredBytes() > before);
  expect(drain.mux.stats().streams).toBe(1);
  drain.clock.advance(1);
  await turns(() => drain.after.length > 0);

  expect(drain.after).toEqual(["reset"]);
  expect(drain.mux.stats().streams).toBe(0);
  expect(drain.deliveredBytes()).toBeLessThan(drain.last.byteLength);
});

test.each(["peer reset", "mux close"])(
  "a %s during a closed stream's drain releases it without reporting it complete",
  async (cancel) => {
    const drain = await closedWhileDraining();
    if (cancel === "peer reset") drain.peer(encodeFrame(kinds.reset, 1));
    else drain.mux.close();
    await turns(() => drain.mux.stats().pendingPayloadBytes === 0);
    drain.clock.advance(gracefulDrainMs);
    await new Promise((resolve) => setImmediate(resolve));

    expect(drain.mux.stats().streams).toBe(0);
    expect(drain.after).toEqual([]);
  },
);

/** Waits on real I/O: up to five seconds for `condition`. */
// Generous: these runs move tens of megabytes over real sockets, and a loaded machine stretches
// them. A condition that holds returns as soon as it does; only a failure waits this long.
const within = async (condition: () => boolean) => {
  for (const started = Date.now(); !condition() && Date.now() - started < 15_000;)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error("Condition never held");
};

/**
 * Both ends of the mux over real TCP: a dev server on the machine's side, dialed as a socket that
 * closes once the server's end arrives (not half-open, as Bun's are), and a browser's connection
 * on the device's side. The browser reads at once, or holds its reads so the device's socket
 * pushes back. Frames cross in memory, each way in order.
 */
async function overRealTcp(serve: (socket: Socket) => void, reads: "at once" | "held") {
  const frames: { from: "machine" | "device"; kind: number; bytes: number }[] = [];
  const ends: Record<"machine" | "device", ((frame: Uint8Array) => void) | undefined> = {
    machine: undefined,
    device: undefined,
  };
  const channel = (from: "machine" | "device"): PreviewChannel => ({
    async send(bytes) {
      const frame = decodeFrame(bytes);
      frames.push({ from, kind: frame.kind, bytes: frame.data.byteLength });
      const copy = bytes.slice();
      queueMicrotask(() => ends[from === "machine" ? "device" : "machine"]?.(copy));
    },
    close() {},
    subscribe(onFrame) {
      ends[from] = onFrame;
      return () => {
        ends[from] = undefined;
      };
    },
  });
  const devServer = createServer(serve);
  devServer.listen(0, "127.0.0.1");
  await once(devServer, "listening");
  cleanup.push(() => new Promise<void>((resolve) => devServer.close(() => resolve())));
  const devAddress = devServer.address();
  if (!devAddress || typeof devAddress === "string") throw new Error("Missing dev server");
  const machine = createMux({
    channel: channel("machine"),
    maxStreams: 4,
    timer: systemTimer,
    allowPort: async () => true,
    socketFactory: (port) => {
      const socket = new Socket();
      socket.on("error", () => {});
      return {
        socket: previewSocket(socket),
        connect: () => socket.connect(port, "127.0.0.1"),
      };
    },
  });
  const device = createMux({ channel: channel("device"), maxStreams: 4, timer: systemTimer });
  cleanup.push(machine.close, device.close);
  const listener = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    device.open(previewSocket(socket), devAddress.port);
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  cleanup.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  // A small receive buffer, so held reads push back on the device's socket within a few windows.
  const browser = connect({ host: "127.0.0.1", port: address.port });
  browser.on("error", () => {});
  cleanup.push(() => {
    browser.destroy();
  });
  let received = 0;
  const outcome = { ended: false, closed: false };
  if (reads === "held") browser.pause();
  browser.on("data", (bytes: Buffer) => {
    received += bytes.byteLength;
  });
  browser.on("end", () => {
    outcome.ended = true;
  });
  browser.on("close", () => {
    outcome.closed = true;
  });
  await once(browser, "connect");
  browser.write("GET / HTTP/1.1\r\n\r\n");
  return {
    frames,
    outcome,
    machine,
    device,
    received: () => received,
    /** Lets a held browser read from now on. */
    read: () => browser.resume(),
    hold: () => browser.pause(),
    /** Lets a held browser read one chunk, then holds it again, however long that takes. */
    readOne: () =>
      new Promise<void>((resolve) => {
        browser.once("data", () => {
          browser.pause();
          resolve();
        });
        browser.resume();
      }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.each(["at once", "held"] as const)(
  "a server that closes after its whole answer, before the browser ends, delivers every byte (browser reads %s)",
  async (reads) => {
    const answer = Buffer.alloc(24 * 1024 * 1024, 7);
    const run = await overRealTcp((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end(answer));
    }, reads);
    if (reads === "held") {
      // The browser reads one chunk at a time with pauses between, so the machine sends the
      // whole answer and its END, and its socket closes, while part of the answer still waits on
      // the device's side. A burst is one chunk, not a span of time, so a loaded machine that
      // runs late still leaves the rest unread.
      const machineEnded = () =>
        run.frames.some((frame) => frame.from === "machine" && frame.kind === kinds.end);
      for (let bursts = 0; !machineEnded() && bursts < 2000; bursts++) {
        await run.readOne();
        await sleep(5);
      }
      await sleep(50);
      expect(machineEnded()).toBe(true);
      expect(run.received()).toBeLessThan(answer.byteLength);
      run.read();
    }
    await within(() => run.outcome.ended);
    expect(run.received()).toBe(answer.byteLength);
    // A close after an answer is no abort: neither side resets.
    expect(run.frames.filter((frame) => frame.kind === kinds.reset)).toEqual([]);
  },
);

test.each(["at once", "held"] as const)(
  "a server that aborts mid-answer resets the stream on both sides (browser reads %s)",
  async (reads) => {
    const sent = 24 * 1024 * 1024;
    const run = await overRealTcp((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.write(Buffer.alloc(sent, 7));
        setTimeout(() => socket.resetAndDestroy(), 50);
      });
    }, reads);
    await within(() =>
      run.frames.some((frame) => frame.from === "machine" && frame.kind === kinds.reset),
    );
    // An abort drops what still waited for the browser's socket.
    if (reads === "held") run.read();
    await within(() => run.outcome.closed);
    const carried = run.frames
      .filter((frame) => frame.from === "machine")
      .reduce((total, frame) => total + frame.bytes, 0);
    if (reads === "held") expect(run.received()).toBeLessThan(carried);
    expect(run.frames.some((frame) => frame.kind === kinds.end)).toBe(false);
    await within(() => run.machine.stats().streams === 0 && run.device.stats().streams === 0);
  },
);

/**
 * The machine's side of the mux dialing a real dev server, with the test as its peer: frames it
 * sends are recorded, and an END it sends waits until `releaseEnd` when `holdEnd` is set. Its
 * socket is half-open with `halfOpen`; otherwise it ends and closes once the server's end arrives.
 */
async function machineFacing(
  serve: (socket: Socket) => void,
  options: { timer: MuxTimer; holdEnd?: boolean; halfOpen?: boolean },
) {
  const { timer, holdEnd = false, halfOpen = false } = options;
  const frames: { kind: number; value: number }[] = [];
  let receive: ((frame: Uint8Array) => void) | undefined;
  let closed = false;
  const { promise: endGate, resolve: releaseEnd } = Promise.withResolvers<void>();
  if (!holdEnd) releaseEnd();
  const devServer = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    serve(socket);
  });
  devServer.listen(0, "127.0.0.1");
  await once(devServer, "listening");
  cleanup.push(() => new Promise<void>((resolve) => devServer.close(() => resolve())));
  const address = devServer.address();
  if (!address || typeof address === "string") throw new Error("Missing dev server");
  const mux = createMux({
    maxStreams: 1,
    timer,
    allowPort: async () => true,
    socketFactory: (port) => {
      const socket = new Socket({ allowHalfOpen: halfOpen });
      socket.on("error", () => {});
      return {
        socket: previewSocket(socket),
        connect: () => socket.connect(port, "127.0.0.1"),
      };
    },
    channel: {
      async send(bytes) {
        const frame = decodeFrame(bytes);
        frames.push({ kind: frame.kind, value: frame.value });
        if (frame.kind === kinds.end) await endGate;
      },
      close() {
        closed = true;
      },
      subscribe(onFrame) {
        receive = onFrame;
        return () => {
          receive = undefined;
        };
      },
    },
  });
  cleanup.push(mux.close);
  const peer = (kind: number, value = 0, data?: Uint8Array) =>
    receive?.(encodeFrame(kind, 1, value, data));
  peer(kinds.open, address.port);
  await within(() => frames.some((frame) => frame.kind === kinds.ready));
  return { mux, frames, peer, releaseEnd, closed: () => closed };
}

test("a peer that only returns credit cannot hold a closed stream's slot past the deadline from its close", async () => {
  const clock = manualTimer();
  // A server that answers and closes at once; the peer never ends.
  const run = await machineFacing((socket) => socket.end("answer"), { timer: clock.timer });
  await within(() => run.frames.some((frame) => frame.kind === kinds.end));
  // Its socket has closed: wait for the mux to hear it.
  await sleep(50);
  const sentBytes = run.frames.find((frame) => frame.kind === kinds.data)?.value ?? 0;
  expect(sentBytes).toBe(6);
  for (let i = 0; i < sentBytes; i++) {
    clock.advance(Math.floor(gracefulDrainMs / sentBytes) - 1);
    run.peer(kinds.credit, 1);
  }
  clock.advance(gracefulDrainMs - (Math.floor(gracefulDrainMs / sentBytes) - 1) * sentBytes - 1);
  expect(run.mux.stats().streams).toBe(1);
  clock.advance(1);
  expect(run.mux.stats().streams).toBe(0);
  await within(() => run.frames.some((frame) => frame.kind === kinds.reset));
  expect(run.closed()).toBe(false);
});

test("the peer's END while ours still waits to go leaves every byte it sent for the server, then its end", async () => {
  const received: Buffer[] = [];
  const { promise: serverEnded, resolve: ended } = Promise.withResolvers<void>();
  const run = await machineFacing(
    (socket) => {
      socket.on("data", (bytes: Buffer) => received.push(bytes));
      socket.on("end", () => ended());
      // The server answers and ends its side first; it keeps reading.
      socket.end("answer");
    },
    { timer: systemTimer, holdEnd: true, halfOpen: true },
  );
  await within(() => run.frames.some((frame) => frame.kind === kinds.end));
  // Our END is still waiting to go; the peer sends a window's worth and its END.
  const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
  for (let offset = 0; offset < body.byteLength; offset += 16_384) {
    const piece = body.subarray(offset, offset + 16_384);
    run.peer(kinds.data, piece.byteLength, piece);
  }
  run.peer(kinds.end);
  await serverEnded;
  expect(Buffer.concat(received)).toEqual(body);
  run.releaseEnd();
  await within(() => run.mux.stats().streams === 0);
  expect(run.frames.some((frame) => frame.kind === kinds.reset)).toBe(false);
});
