import { expect, test } from "vitest";
import { createMux, gracefulDrainMs, type PreviewSocket } from "./relay-mux.ts";
import { decodeFrame, encodeFrame, kinds, type Frame } from "./relay-wire.ts";

/*
 * The host side of the stream mux with sockets that stand in for loopback ones: what a peer's
 * frames turn into on the socket, and what the mux sends back.
 */

/** A socket whose writes complete only when the test lets them. */
function heldSocket() {
  const writes: Uint8Array[] = [];
  const callbacks: (() => void)[] = [];
  const state = { ended: false, destroyed: false, endedAfter: -1 };
  let connected: (() => void) | undefined;
  const listeners = new Map<string, ((bytes: Uint8Array) => void)[]>();
  const socket: PreviewSocket = {
    readableLength: 0,
    writableLength: 0,
    pause() {},
    resume() {},
    destroy() {
      state.destroyed = true;
    },
    end() {
      state.ended = true;
      state.endedAfter = writes.length;
    },
    write(bytes, callback) {
      writes.push(bytes.slice());
      callbacks.push(() => callback());
    },
    on(event: string, listener: (bytes: Uint8Array) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    once(_event, listener) {
      connected = listener;
    },
  };
  return {
    socket,
    writes,
    state,
    connect: () => connected?.(),
    /** What the socket's own side does: `end` (its FIN), `close`, or `data` it read. */
    emit(event: "end" | "close" | "data" | "abort", bytes = new Uint8Array(0)) {
      for (const listener of listeners.get(event) ?? []) listener(bytes);
    },
    /** Completes the oldest write in flight. */
    drain() {
      callbacks.shift()?.();
    },
    get inFlight() {
      return callbacks.length;
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function host(
  options: {
    admitOpen?: (port: number) => boolean;
    maxQueuedBytes?: number;
    canConnect?: () => boolean;
  } = {},
) {
  const sent: Frame[] = [];
  const removed: { id: number; sentBefore: number }[] = [];
  let receive: ((frame: Uint8Array) => void) | undefined;
  const sockets: ReturnType<typeof heldSocket>[] = [];
  let dials = 0;
  /** Timers armed and not cancelled; they run only as `advance` moves the clock past them. */
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  let channelClosed = false;
  const mux = createMux({
    maxStreams: 8,
    timer: (run, ms) => {
      const entry = { at: now + ms, run };
      timers.add(entry);
      return () => timers.delete(entry);
    },
    ...(options.maxQueuedBytes === undefined ? {} : { maxQueuedBytes: options.maxQueuedBytes }),
    ...(options.admitOpen ? { admitOpen: options.admitOpen } : {}),
    ...(options.canConnect ? { canConnect: options.canConnect } : {}),
    onStreamRemoved: (id) => removed.push({ id, sentBefore: sent.length }),
    allowPort: async () => true,
    socketFactory: () => {
      const made = heldSocket();
      sockets.push(made);
      return {
        socket: made.socket,
        connect: () => {
          dials++;
          queueMicrotask(made.connect);
        },
      };
    },
    channel: {
      async send(bytes) {
        sent.push(decodeFrame(bytes));
      },
      close() {
        channelClosed = true;
      },
      subscribe(onFrame) {
        receive = onFrame;
        return () => {};
      },
    },
  });
  const peer = (kind: number, id: number, value = 0, data?: Uint8Array) =>
    receive?.(encodeFrame(kind, id, value, data));
  const opened = async (id: number) => {
    peer(kinds.open, id, 3000);
    await settle();
    const made = sockets.at(-1);
    if (!made) throw new Error("No socket made");
    return made;
  };
  const credit = (id: number) =>
    sent
      .filter((frame) => frame.kind === kinds.credit && frame.id === id)
      .reduce((sum, frame) => sum + frame.value, 0);
  const advance = (ms: number) => {
    now += ms;
    for (const entry of timers) {
      if (entry.at > now) continue;
      timers.delete(entry);
      entry.run();
    }
  };
  return {
    mux,
    sent,
    sockets,
    peer,
    opened,
    credit,
    removed,
    advance,
    get channelClosed() {
      return channelClosed;
    },
    get dials() {
      return dials;
    },
  };
}

const byte = (value: number) => new Uint8Array([value]);

test("one-byte frames to a socket that stops reading leave one write pending, then arrive joined", async () => {
  const { peer, opened, credit } = host();
  const socket = await opened(1);
  for (let i = 0; i < 1000; i++) peer(kinds.data, 1, 1, byte(i % 251));
  await settle();
  // The socket took the first byte and has not finished it: everything else waits in one queue.
  expect(socket.writes).toHaveLength(1);
  expect(socket.inFlight).toBe(1);
  expect(credit(1)).toBe(0);
  socket.drain();
  await settle();
  expect(socket.writes).toHaveLength(2);
  expect(socket.writes[1]?.byteLength).toBe(999);
  socket.drain();
  await settle();
  const received = Buffer.concat(socket.writes);
  expect(Array.from(received)).toEqual(Array.from({ length: 1000 }, (_, i) => i % 251));
  // Credit comes back for every byte, once each write has gone.
  expect(credit(1)).toBe(1000);
});

test("the peer's END ends the socket only after the bytes still waiting are written", async () => {
  const { peer, opened } = host();
  const socket = await opened(1);
  peer(kinds.data, 1, 1, byte(1));
  peer(kinds.data, 1, 1, byte(2));
  peer(kinds.end, 1);
  await settle();
  expect(socket.state.ended).toBe(false);
  socket.drain();
  socket.drain();
  await settle();
  expect(socket.state.ended).toBe(true);
  expect(socket.state.endedAfter).toBe(2);
  expect(Array.from(Buffer.concat(socket.writes))).toEqual([1, 2]);
});

test("bytes queued past the mux's bound reset the stream that sent them", async () => {
  const { peer, sent, opened } = host({ maxQueuedBytes: 4 });
  const first = await opened(1);
  const second = await opened(2);
  for (let i = 0; i < 3; i++) peer(kinds.data, 1, 1, byte(i));
  peer(kinds.data, 2, 1, byte(9));
  await settle();
  // Four bytes wait across both streams; a fifth on either is past the bound.
  peer(kinds.data, 2, 1, byte(10));
  await settle();
  expect(sent.some((frame) => frame.kind === kinds.reset && frame.id === 2)).toBe(true);
  expect(second.state.destroyed).toBe(true);
  expect(first.state.destroyed).toBe(false);
  // The reset stream's bytes no longer count: the first stream can queue again.
  peer(kinds.data, 1, 1, byte(3));
  await settle();
  expect(sent.some((frame) => frame.kind === kinds.reset && frame.id === 1)).toBe(false);
});

test("an OPEN the host refuses at once is reset before any socket exists", async () => {
  const { peer, sent, sockets } = host({ admitOpen: (port) => port !== 3000 });
  peer(kinds.open, 1, 3000);
  await settle();
  expect(sockets).toHaveLength(0);
  expect(sent.map((frame) => [frame.kind, frame.id])).toEqual([[kinds.reset, 1]]);
});

test("the host can reset one open stream and leave the others", async () => {
  const { mux, sent, opened } = host();
  const first = await opened(1);
  const second = await opened(2);
  mux.reset(1);
  mux.reset(99);
  await settle();
  expect(first.state.destroyed).toBe(true);
  expect(second.state.destroyed).toBe(false);
  expect(sent.filter((frame) => frame.kind === kinds.reset).map((frame) => frame.id)).toEqual([1]);
});

test("a RESET after the peer's END is still an abort: what waited for the socket is dropped", async () => {
  const { peer, opened } = host();
  const socket = await opened(1);
  peer(kinds.data, 1, 1, byte(1));
  peer(kinds.data, 1, 1, byte(2));
  peer(kinds.end, 1);
  peer(kinds.reset, 1);
  await settle();
  expect(Array.from(Buffer.concat(socket.writes))).toEqual([1]);
  expect(socket.state.ended).toBe(false);
  expect(socket.state.destroyed).toBe(true);
});

const kindsOf = (sent: Frame[]) => sent.map((frame) => frame.kind);

test("a socket that closes after its answer leaves the stream half-closed until the peer's END, with no RESET", async () => {
  const { peer, opened, sent, removed } = host();
  const socket = await opened(1);
  socket.emit("end");
  socket.emit("close");
  await settle();
  expect(kindsOf(sent)).toEqual([kinds.ready, kinds.end]);
  expect(removed).toEqual([]);
  // The peer had not ended; its END finishes the stream both ways.
  peer(kinds.end, 1);
  await settle();
  expect(removed.map((entry) => entry.id)).toEqual([1]);
  expect(kindsOf(sent)).not.toContain(kinds.reset);
});

test("a half-closed stream is reset when the peer sends data nothing can read", async () => {
  const { peer, opened, sent, removed } = host();
  const socket = await opened(1);
  socket.emit("end");
  socket.emit("close");
  await settle();
  peer(kinds.data, 1, 1, byte(1));
  await settle();
  expect(removed.map((entry) => entry.id)).toEqual([1]);
  expect(kindsOf(sent).at(-1)).toBe(kinds.reset);
  expect(socket.writes).toHaveLength(0);
});

test("a half-closed stream is reset at a deadline from its close that the peer's credit never extends", async () => {
  const made = host();
  const { peer, opened, sent, removed, advance } = made;
  const socket = await opened(1);
  // The socket answers with four bytes, ends and closes; the peer has not ended.
  socket.emit("data", new Uint8Array([1, 2, 3, 4]));
  await settle();
  socket.emit("end");
  socket.emit("close");
  await settle();
  expect(kindsOf(sent)).toEqual([kinds.ready, kinds.data, kinds.end]);
  // The peer acknowledges the bytes one at a time, right up to the deadline.
  for (let i = 0; i < 4; i++) {
    advance(gracefulDrainMs / 4 - 1);
    peer(kinds.credit, 1, 1);
    await settle();
  }
  expect(removed).toEqual([]);
  advance(3);
  expect(removed).toEqual([]);
  advance(1);
  await settle();
  expect(removed.map((entry) => entry.id)).toEqual([1]);
  expect(kindsOf(sent).at(-1)).toBe(kinds.reset);
  expect(made.channelClosed).toBe(false);
});

test("a half-closed stream's credit for bytes it never sent closes the channel", async () => {
  const made = host();
  const socket = await made.opened(1);
  socket.emit("end");
  socket.emit("close");
  await settle();
  made.peer(kinds.credit, 1, 1);
  await settle();
  expect(made.channelClosed).toBe(true);
});

test("a socket that closes before taking what the peer sent resets the stream, though both sides ended", async () => {
  const { peer, opened, sent, removed } = host();
  const socket = await opened(1);
  socket.emit("end");
  // Our END is queued; before it goes, the peer sends its bytes and its END.
  peer(kinds.data, 1, 1, byte(1));
  peer(kinds.data, 1, 1, byte(2));
  peer(kinds.end, 1);
  socket.emit("close");
  await settle();
  // The socket closed with bytes it never took: they can't be delivered, so the stream resets.
  expect(kindsOf(sent).at(-1)).toBe(kinds.reset);
  expect(removed.map((entry) => entry.id)).toEqual([1]);
});

test("a peer's END while ours waits to go: the socket gets every byte, then its end, and nothing resets", async () => {
  const { peer, opened, sent, removed } = host();
  const socket = await opened(1);
  socket.emit("end");
  peer(kinds.data, 1, 1, byte(1));
  peer(kinds.data, 1, 1, byte(2));
  peer(kinds.end, 1);
  await settle();
  expect(socket.state.ended).toBe(false);
  socket.drain();
  socket.drain();
  await settle();
  expect(socket.state.endedAfter).toBe(2);
  expect(removed).toEqual([]);
  socket.emit("close");
  await settle();
  expect(removed.map((entry) => entry.id)).toEqual([1]);
  expect(kindsOf(sent)).not.toContain(kinds.reset);
});

test("an abort after the socket's end resets the stream at once", async () => {
  const { peer, opened, sent, removed } = host();
  const socket = await opened(1);
  socket.emit("end");
  await settle();
  expect(kindsOf(sent)).toEqual([kinds.ready, kinds.end]);
  socket.emit("abort");
  await settle();
  expect(kindsOf(sent).at(-1)).toBe(kinds.reset);
  expect(removed.map((entry) => entry.id)).toEqual([1]);
  expect(socket.state.destroyed).toBe(true);
  // The peer's END that crosses the RESET finds nothing.
  peer(kinds.end, 1);
  expect(removed).toHaveLength(1);
});

test("a peer that resets without ending drops what still waited for the socket", async () => {
  const { peer, opened } = host();
  const socket = await opened(1);
  peer(kinds.data, 1, 1, byte(1));
  peer(kinds.data, 1, 1, byte(2));
  peer(kinds.reset, 1);
  await settle();
  expect(Array.from(Buffer.concat(socket.writes))).toEqual([1]);
  expect(socket.state.ended).toBe(false);
  expect(socket.state.destroyed).toBe(true);
});

test("a stream refused as its socket connects is reset and never READY", async () => {
  // Allowed as the dial starts; by the time the socket connects the port is no longer allowed.
  let asked = 0;
  const { peer, sent, sockets, removed } = host({ canConnect: () => ++asked === 1 });
  peer(kinds.open, 1, 3000);
  await settle();
  expect(asked).toBe(2);
  expect(sockets[0]?.state.destroyed).toBe(true);
  expect(sent.map((frame) => [frame.kind, frame.id])).toEqual([[kinds.reset, 1]]);
  // Its slot was freed before the RESET went out.
  expect(removed).toEqual([{ id: 1, sentBefore: 0 }]);
});

test("a stream refused before its socket dials is reset without a connect", async () => {
  const made = host({ canConnect: () => false });
  const { peer, sent, sockets } = made;
  peer(kinds.open, 1, 3000);
  await settle();
  expect(made.dials).toBe(0);
  expect(sockets[0]?.state.destroyed).toBe(true);
  expect(sent.map((frame) => [frame.kind, frame.id])).toEqual([[kinds.reset, 1]]);
});
