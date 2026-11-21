import { createMux, type PreviewSocket, type StreamRemoval } from "@ace/preview/mux";
import { expect, test } from "vitest";
import { tunnelStream } from "./tunnel-stream.ts";

/*
 * A tunnel stream on the device's mux (ADR 0194, "Stream lifecycle"), against the machine's mux
 * over an in-memory link, with the machine's loopback socket played by the test: what the
 * caller and reader see, and what reaches the machine's socket.
 */

/** The machine's loopback socket: what it is asked to do, and what it reports. */
function loopbackSocket() {
  const listeners = new Map<string, ((bytes: Uint8Array) => void)[]>();
  const seen = { ended: false, removal: undefined as StreamRemoval | undefined };
  let connected: (() => void) | undefined;
  const socket: PreviewSocket = {
    readableLength: 0,
    writableLength: 0,
    pause() {},
    resume() {},
    destroy(removal) {
      seen.removal ??= removal;
    },
    end() {
      seen.ended = true;
    },
    write: (_bytes, callback) => callback(),
    on(event: string, listener: (bytes: Uint8Array) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    once(_event, listener) {
      connected = listener;
    },
  };
  return {
    socket,
    seen,
    connect: () => connected?.(),
    emit(event: "data" | "end" | "close" | "abort", bytes = new Uint8Array(0)) {
      for (const listener of listeners.get(event) ?? []) listener(bytes);
    },
  };
}

const noTimer = () => () => {};

function device() {
  const loopback = loopbackSocket();
  let toMachine: ((frame: Uint8Array) => void) | undefined;
  let toDevice: ((frame: Uint8Array) => void) | undefined;
  /** Frames from the device the link has not admitted yet, while it holds them. */
  const held: { frame: Uint8Array; admit(): void }[] = [];
  let holding = false;
  createMux({
    maxStreams: 4,
    timer: noTimer,
    allowPort: async () => true,
    socketFactory: () => ({
      socket: loopback.socket,
      connect: () => queueMicrotask(loopback.connect),
    }),
    channel: {
      send: async (frame) => toDevice?.(frame),
      close() {},
      subscribe(onFrame) {
        toMachine = onFrame;
        return () => {};
      },
    },
  });
  const mux = createMux({
    maxStreams: 4,
    timer: noTimer,
    channel: {
      send(frame) {
        if (!holding) return Promise.resolve(toMachine?.(frame));
        const { promise, resolve } = Promise.withResolvers<void>();
        held.push({ frame, admit: resolve });
        return promise;
      },
      close() {},
      subscribe(onFrame) {
        toDevice = onFrame;
        return () => {};
      },
    },
  });
  const { socket, stream } = tunnelStream(ReadableStream, { opened() {}, failed() {} });
  mux.open(socket, 3000);
  return {
    stream,
    mux,
    loopback,
    /** The link stops admitting the device's frames: our END waits to go. */
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const { frame, admit } of held.splice(0)) {
        toMachine?.(frame);
        admit();
      }
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const bytes: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes.push(...value);
  }
}

test.each(["reset()", "a reader that cancels"])(
  "%s after both sides ended, while our END is still on its way, still resets the machine's side",
  async (abort) => {
    const run = device();
    await settle();
    run.hold();
    run.stream.end();
    // The machine answers and ends too: both ends reached the tunnel stream while the mux still
    // owes its END. The answer is unread, so a reader can still cancel (once it has read the end
    // there is nothing left to cancel).
    run.loopback.emit("data", new Uint8Array([1]));
    run.loopback.emit("end");
    await settle();
    expect(run.loopback.seen.ended).toBe(false);

    if (abort === "reset()") run.stream.reset();
    else await run.stream.readable.cancel();
    await settle();
    run.release();
    await settle();

    // The END arrives, then the RESET behind it: the machine's socket is aborted, not finished.
    expect(run.loopback.seen.removal).toBe("reset");
    expect(run.mux.stats().streams).toBe(0);
    await run.stream.closed;
  },
);

test("the machine's END then RESET errors the reader, and bytes it had not read are discarded", async () => {
  const run = device();
  await settle();
  run.loopback.emit("data", new Uint8Array([1, 2, 3]));
  await settle();
  run.loopback.emit("end");
  await settle();
  run.loopback.emit("abort");
  await settle();

  await expect(readAll(run.stream.readable)).rejects.toMatchObject({ code: "tunnel_reset" });
});

test("a stream both sides end reads every byte and its end, and finishes without a RESET", async () => {
  const run = device();
  await settle();
  run.loopback.emit("data", new Uint8Array([1, 2, 3]));
  await settle();
  run.loopback.emit("end");
  run.stream.end();
  await settle();
  run.loopback.emit("close");
  await settle();

  expect(await readAll(run.stream.readable)).toEqual([1, 2, 3]);
  expect(run.loopback.seen.removal).toBe("finished");
  expect(run.mux.stats().streams).toBe(0);
  await run.stream.closed;
});
