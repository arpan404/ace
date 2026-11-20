import { createMux, systemTimer, type PreviewSocket } from "@ace/preview/mux";
import { expect, test } from "vitest";
import { ClientError } from "./errors.ts";
import { openMachineTunnel, type TunnelLink } from "./machine-tunnel.ts";

/*
 * Giving up a tunnel open (ADR 0194): the device's proxy has a deadline for each connection,
 * and a stream it gave up on must not stay open on the machine. The far side here is the
 * preview mux as the machine runs it, behind an in-memory link.
 */

const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** A machine whose loopback port never answers, and whether its side of a stream was dropped. */
function machine(options: { welcome: boolean }) {
  const asked: number[] = [];
  const dropped: number[] = [];
  let toDevice: ((frame: Uint8Array) => void) | undefined;
  let toMachine: ((frame: Uint8Array) => void) | undefined;
  createMux({
    channel: {
      send: async (frame) => toDevice?.(frame),
      close: () => {},
      subscribe(onFrame) {
        toMachine = onFrame;
        return () => {};
      },
    },
    maxStreams: 8,
    allowPort: async () => true,
    socketFactory: (_port, id) => {
      asked.push(id);
      const socket: PreviewSocket = {
        readableLength: 0,
        writableLength: 0,
        pause: () => {},
        resume: () => {},
        destroy: () => dropped.push(id),
        end: () => {},
        write: (_bytes, callback) => callback(),
        on: () => {},
        // The port's connect never completes, so the stream is never READY.
        once: () => {},
      };
      return { socket, connect: () => {} };
    },
    timer: systemTimer,
  });
  const link: TunnelLink = {
    open(events) {
      toDevice = (frame) => void events.message(frame);
      if (options.welcome) queueMicrotask(() => events.ready());
    },
    sendBinary: async (bytes) => toMachine?.(bytes),
    close: () => {},
  };
  return { link, asked, dropped };
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "opened",
    (error: unknown) => (error instanceof ClientError ? error.code : String(error)),
  );

test("an open given up before the port answers rejects and resets the machine's side", async () => {
  const far = machine({ welcome: true });
  const tunnel = openMachineTunnel({
    path: { get: () => ({ key: "lan", link: () => far.link }), subscribe: () => () => {} },
    schedule,
  });
  const controller = new AbortController();
  const opening = code(tunnel.open(3000, { signal: controller.signal }));
  // The machine has the OPEN and is still connecting to the port.
  await expect.poll(() => far.asked).toEqual([1]);
  controller.abort();
  expect(await opening).toBe("tunnel_cancelled");
  await expect.poll(() => far.dropped).toEqual([1]);
  tunnel.close();
});

test("an open given up while the tunnel waits for its welcome rejects at once", async () => {
  const far = machine({ welcome: false });
  const tunnel = openMachineTunnel({
    path: { get: () => ({ key: "lan", link: () => far.link }), subscribe: () => () => {} },
    schedule,
  });
  const controller = new AbortController();
  const opening = code(tunnel.open(3000, { signal: controller.signal }));
  controller.abort();
  expect(await opening).toBe("tunnel_cancelled");
  // An open already given up never starts.
  expect(await code(tunnel.open(3000, { signal: controller.signal }))).toBe("tunnel_cancelled");
  expect(far.asked).toEqual([]);
  tunnel.close();
});
