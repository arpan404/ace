import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, expect, test } from "vitest";
import {
  openMachineTunnel,
  type MachineTunnel,
  type TunnelLink,
  type TunnelPath,
  type TunnelStream,
} from "@ace/client/machine-tunnel";
import { attachPreviewRelay } from "@ace/preview";
import { createMux, type PreviewSocket } from "@ace/preview/mux";
import { AcePorts } from "./ace-ports.ts";
import { createTunnelHost, type TunnelConnection, type TunnelHost } from "./host.ts";
import type { TunnelLimits } from "./policy.ts";
import { machinePortWatch } from "./port-feed.ts";

/*
 * The tunnel end to end over real loopback sockets (ADR 0194): the client's tunnel, the
 * machine's host and @ace/preview's mux, joined by an in-memory link standing in for the path
 * (the direct and relay carriers have process tests of their own). Real edge: the machine side
 * dials real TCP listeners on 127.0.0.1 and ::1.
 */

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

async function listen(server: Server | HttpServer, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** A TCP echo server; `connections` counts what reached it. */
async function echo(host = "127.0.0.1") {
  const state = { connections: 0 };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    state.connections++;
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  return { port: await listen(server, host), state };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readAll(stream: TunnelStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(value);
  }
}

/** One device's tunnel connection on a path, joined in memory to the host. */
function memoryPath(key: string, host: TunnelHost, device: { operate: () => boolean }) {
  const made: { open: boolean }[] = [];
  /** Kinds of the frames the device sent, in order. */
  const sent: number[] = [];
  const path: TunnelPath = {
    key,
    link(): TunnelLink {
      const state = { open: true };
      made.push(state);
      let events: Parameters<TunnelLink["open"]>[0] | undefined;
      let toHost: ((frame: Uint8Array) => void) | undefined;
      let hostLost: (() => void) | undefined;
      const close = () => {
        if (!state.open) return;
        state.open = false;
        hostLost?.();
        queueMicrotask(() => events?.close());
      };
      // One queue each way, as one socket keeps JSON and binary in order.
      const toClient = (message: Parameters<NonNullable<typeof events>["message"]>[0]) =>
        new Promise<void>((resolve, reject) => {
          if (!state.open) return reject(new Error("closed"));
          queueMicrotask(() => {
            if (state.open) void events?.message(message);
            resolve();
          });
        });
      const connection: TunnelConnection = {
        device: "phone",
        operate: device.operate,
        sendJson: (message) => toClient(message),
        channel: {
          send: (frame) => toClient(frame.slice()),
          close,
          subscribe(onFrame, onClose) {
            toHost = onFrame;
            hostLost = onClose;
            return () => {};
          },
        },
        close,
      };
      return {
        open(next) {
          events = next;
          queueMicrotask(() => {
            next.ready();
            host.attach(connection);
          });
        },
        async sendBinary(bytes) {
          if (!state.open) throw new Error("closed");
          if (bytes[1] !== undefined) sent.push(bytes[1]);
          const copy = bytes.slice();
          queueMicrotask(() => {
            if (state.open) toHost?.(copy);
          });
        },
        close,
      };
    },
  };
  return { path, made, sent };
}

/** The host's pauses, at most 20 ms here. */
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(ms, 20));
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

function setup(
  options: {
    acePorts?: number[];
    listening?: Set<number>;
    operate?: boolean;
    limits?: TunnelLimits;
    /** Scans fail until this is cleared. */
    scanFails?: { now: boolean };
    /** Scans wait for this first. */
    scanGate?: Promise<void>;
  } = {},
) {
  let enabled = true;
  let enabledChanged: ((value: boolean) => void) | undefined;
  const authority = { operate: options.operate ?? true };
  const listening = options.listening ?? new Set<number>();
  const owned = new Set(options.acePorts ?? []);
  const scans = { count: 0 };
  const acePorts = new AcePorts({ published: () => [], now: () => performance.now() });
  const ports = machinePortWatch({
    scan: async () => {
      scans.count++;
      await options.scanGate;
      if (options.scanFails?.now) throw new Error("scan failed");
      return { listening, owned };
    },
    acePorts,
    now: () => performance.now(),
    wait,
    limit: 1024,
    onError: () => {},
  });
  const host = createTunnelHost({
    enabled: async () => enabled,
    watchEnabled(changed) {
      enabledChanged = changed;
      return () => {};
    },
    acePorts,
    ports,
    wait,
    now: () => performance.now(),
    loadMux: async () => attachPreviewRelay,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  cleanups.push(() => host.close());
  const first = memoryPath("lan", host, { operate: () => authority.operate });
  let current: TunnelPath | undefined = first.path;
  const pathListeners = new Set<() => void>();
  const tunnel: MachineTunnel = openMachineTunnel({
    path: {
      get: () => current,
      subscribe(changed) {
        pathListeners.add(changed);
        return () => pathListeners.delete(changed);
      },
    },
    schedule,
    drainMs: 2_000,
  });
  cleanups.push(() => tunnel.close());
  return {
    host,
    tunnel,
    first,
    authority,
    listening,
    acePorts,
    owned,
    scans,
    move(path: TunnelPath | undefined) {
      current = path;
      for (const listener of pathListeners) listener();
    },
    setEnabled(value: boolean) {
      enabled = value;
      enabledChanged?.(value);
    },
  };
}

/** An HTTP server on `host` alone, answering with its own address. */
function served(host: string) {
  const server = createHttpServer((_request, response) => response.end(`hello from ${host}`));
  return listen(server, host);
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "opened",
    (error: unknown) => (error as { code?: string }).code,
  );

test("a page reaches a dev server listening only on ::1, and one only on 127.0.0.1", async () => {
  const v6 = await served("::1");
  const v4 = await served("127.0.0.1");
  const { tunnel } = setup();
  for (const [port, host] of [
    [v6, "::1"],
    [v4, "127.0.0.1"],
  ] as const) {
    const stream = await tunnel.open(port);
    await stream.write(
      new TextEncoder().encode("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
    );
    const response = (await readAll(stream)).toString();
    expect(response).toMatch(/^HTTP\/1\.1 200/);
    expect(response.endsWith(`hello from ${host}`)).toBe(true);
    // The server ended its side; the stream is gone once ours ends too.
    stream.end();
    await stream.closed;
  }
});

test("bytes larger than the window arrive whole and in order, both ways", async () => {
  const { port } = await echo();
  const { tunnel } = setup();
  const stream = await tunnel.open(port);
  const sent = new Uint8Array(3 * 1024 * 1024).map((_, index) => (index * 7) % 251);
  const received = readAll(stream);
  await stream.write(sent);
  stream.end();
  expect(Buffer.compare(await received, Buffer.from(sent))).toBe(0);
  await stream.closed;
});

test("a reset after the device ended its side drops the machine's socket at once, not at a deadline", async () => {
  // A server still answering after the request ended. It writes only once the device's RESET has
  // gone: a socket the machine dropped answers that with a TCP reset, and the server's closes.
  const events: string[] = [];
  const writer = { start: () => {} };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let ticking: ReturnType<typeof setInterval> | undefined;
    writer.start = () => {
      ticking = setInterval(() => socket.write("x"), 5);
    };
    cleanups.push(() => {
      clearInterval(ticking);
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("end", () => events.push("end"));
    socket.on("close", () => {
      clearInterval(ticking);
      events.push("close");
    });
    socket.resume();
  });
  const port = await listen(server, "127.0.0.1");
  const { tunnel, first } = setup();
  const stream = await tunnel.open(port);
  stream.end();
  await expect.poll(() => events).toEqual(["end"]);
  stream.reset();
  // At once: the machine's deadline is 15 s, which a reset taken for a close would wait out.
  await expect.poll(() => first.sent.at(-1), { timeout: 1_000 }).toBe(6);
  writer.start();
  await expect.poll(() => events, { timeout: 2_000 }).toEqual(["end", "close"]);
  await stream.closed;
});

test("a port with nothing listening rejects as reset, never as a refusal", async () => {
  const { tunnel } = setup();
  expect(await code(tunnel.open(await freePort()))).toBe("tunnel_reset");
});

test("a port an ace process holds is refused and never dialed", async () => {
  const ace = await echo();
  const { tunnel } = setup({ acePorts: [ace.port] });
  expect(await code(tunnel.open(ace.port))).toBe("tunnel_port_refused");
  expect(ace.state.connections).toBe(0);
});

test("a device without operate authority is refused the whole tunnel", async () => {
  const { port, state } = await echo();
  const { tunnel } = setup({ operate: false });
  expect(await code(tunnel.open(port))).toBe("tunnel_forbidden");
  expect(state.connections).toBe(0);
});

test("turning the tunnel off resets open streams at once and refuses new ones", async () => {
  const { port } = await echo();
  const { tunnel, setEnabled } = setup();
  const stream = await tunnel.open(port);
  const read = readAll(stream).then(
    () => "ended",
    (error: unknown) => (error as { code?: string }).code,
  );
  setEnabled(false);
  expect(await read).toBe("tunnel_reset");
  await stream.closed;
  expect(await code(tunnel.open(port))).toBe("tunnel_off");
});

test("a device that loses operate has its streams ended at the recheck", async () => {
  const { port } = await echo();
  const { tunnel, host, authority } = setup();
  const stream = await tunnel.open(port);
  authority.operate = false;
  host.recheck();
  await stream.closed;
  expect(await code(tunnel.open(port))).toBe("tunnel_forbidden");
});

test("the device hears the listening ports without ace's, and again only when they change", async () => {
  const listening = new Set([3000, 7777]);
  const { tunnel } = setup({ listening, acePorts: [7777] });
  const heard: (readonly number[])[] = [];
  tunnel.ports.subscribe(() => heard.push(tunnel.ports.get()));
  await expect.poll(() => heard.length).toBe(1);
  expect(heard[0]).toEqual([3000]);
  // Unchanged scans say nothing; a new dev server is heard.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(heard).toHaveLength(1);
  listening.add(5173);
  await expect.poll(() => heard.length).toBe(2);
  expect(heard[1]).toEqual([3000, 5173]);
});

test("after a path switch new streams use the new path while open ones finish on the old", async () => {
  const { port } = await echo();
  const { tunnel, host, first, move } = setup();
  const old = await tunnel.open(port);
  const next = memoryPath("relay", host, { operate: () => true });
  move(next.path);
  const fresh = await tunnel.open(port);
  expect(next.made).toHaveLength(1);
  // The old stream still works on the old path.
  const echoed = readAll(old);
  await old.write(new TextEncoder().encode("still here"));
  old.end();
  expect((await echoed).toString()).toBe("still here");
  await old.closed;
  // Its path closes once nothing is left on it.
  await expect.poll(() => first.made[0]?.open).toBe(false);
  expect(next.made[0]?.open).toBe(true);
  fresh.reset();
});

test("a lost path resets its streams, and the tunnel opens again when a path returns", async () => {
  const { port } = await echo();
  const { tunnel, host, move } = setup();
  const stream = await tunnel.open(port);
  move(undefined);
  await stream.closed;
  expect(await code(tunnel.open(port))).toBe("offline");
  move(memoryPath("tailscale", host, { operate: () => true }).path);
  const again = await tunnel.open(port);
  again.reset();
  await again.closed;
});

test("a port an ace listener in this process binds is refused at once, with no scan since", async () => {
  const { tunnel, acePorts } = setup();
  const { port } = await echo();
  // A first open makes the guard's scan fresh; the next open within its age runs no scan.
  (await tunnel.open(port)).reset();
  const ace = await echo();
  const release = acePorts.hold(ace.port);
  expect(await code(tunnel.open(ace.port))).toBe("tunnel_port_refused");
  expect(ace.state.connections).toBe(0);
  release();
});

test("opens are refused while the scan of ace's processes fails, and allowed once it works", async () => {
  const scanFails = { now: true };
  const { port, state } = await echo();
  const { tunnel } = setup({ scanFails });
  expect(await code(tunnel.open(port))).toBe("tunnel_port_refused");
  expect(state.connections).toBe(0);
  scanFails.now = false;
  const stream = await tunnel.open(port);
  stream.reset();
});

test("a stream already open to a port that becomes ace's is reset", async () => {
  const { port } = await echo();
  const { tunnel, acePorts } = setup();
  const stream = await tunnel.open(port);
  const read = readAll(stream).then(
    () => "ended",
    (error: unknown) => (error as { code?: string }).code,
  );
  acePorts.hold(port);
  expect(await read).toBe("tunnel_reset");
  await stream.closed;
});

test("opens refused for ace's ports still spend the device's rate", async () => {
  const ace = await echo();
  const { port } = await echo();
  const limits = { streamsPerDevice: 10, opensPerSecond: 0.001, openBurst: 3, pendingOpens: 10 };
  const { tunnel } = setup({ acePorts: [ace.port], limits });
  for (let n = 0; n < 3; n++) expect(await code(tunnel.open(ace.port))).toBe("tunnel_port_refused");
  expect(await code(tunnel.open(port))).toBe("tunnel_limit");
});

test("streams refused for ace's ports give their slots back", async () => {
  const ace = await echo();
  const { port } = await echo();
  const limits = { streamsPerDevice: 2, opensPerSecond: 1000, openBurst: 1000, pendingOpens: 10 };
  const { tunnel } = setup({ acePorts: [ace.port], limits });
  for (let n = 0; n < 4; n++) expect(await code(tunnel.open(ace.port))).toBe("tunnel_port_refused");
  const both = await Promise.all([tunnel.open(port), tunnel.open(port)]);
  for (const stream of both) stream.reset();
});

/** A device's side of one tunnel connection, driven frame by frame through a client mux. */
function rawDevice(host: TunnelHost) {
  let toHost: ((frame: Uint8Array) => void) | undefined;
  let toDevice: ((frame: Uint8Array) => void) | undefined;
  const refused: { code: string; stream?: number | undefined }[] = [];
  host.attach({
    device: "phone",
    operate: () => true,
    sendJson: async (message) => {
      if (message.type === "tunnel.refused") refused.push(message);
    },
    channel: {
      send: async (frame) => queueMicrotask(() => toDevice?.(frame.slice())),
      close: () => {},
      subscribe(onFrame) {
        toHost = onFrame;
        return () => {};
      },
    },
    close: () => {},
  });
  const mux = createMux({
    maxStreams: 8,
    timer: schedule,
    channel: {
      send: async (frame) => queueMicrotask(() => toHost?.(frame.slice())),
      close: () => {},
      subscribe(onFrame) {
        toDevice = onFrame;
        return () => {};
      },
    },
  });
  cleanups.push(() => mux.close());
  /** Opens a stream; resolves its id once READY came, or rejects once it was destroyed. */
  const open = (port: number) => {
    const closers: (() => void)[] = [];
    let destroyed = false;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket: PreviewSocket = {
      readableLength: 0,
      writableLength: 0,
      pause() {},
      resume: () => resolve(),
      destroy() {
        destroyed = true;
        reject(new Error("reset"));
      },
      end() {},
      write: (_bytes, callback) => callback(),
      on(event: "data" | "end" | "close" | "error", listener: (bytes: Uint8Array) => void) {
        if (event === "close") closers.push(() => listener(new Uint8Array(0)));
      },
      once() {},
    };
    mux.open(socket, port);
    promise.catch(() => {});
    return {
      ready: promise,
      /** Closes the device's socket with no end: the mux sends RESET. */
      abort: () => {
        if (!destroyed) for (const closer of closers) closer();
      },
    };
  };
  return { open, refused };
}

test("a stream reset while its authorization waits gives its slot back and is never dialed", async () => {
  const gate = Promise.withResolvers<void>();
  const { port, state } = await echo();
  const limits = { streamsPerDevice: 1, opensPerSecond: 1000, openBurst: 1000, pendingOpens: 10 };
  const { host } = setup({ limits, scanGate: gate.promise });
  const device = rawDevice(host);
  const waiting = device.open(port);
  await new Promise((resolve) => setTimeout(resolve, 20));
  waiting.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  // The one slot is free again: the next open is admitted and dialed. READY follows the dial's
  // connect, which can come before the listener's accept runs (it does on macOS), so poll.
  await device.open(port).ready;
  await expect.poll(() => state.connections).toBe(1);
  // The reset open never reached the listener: only the one connection, however long we wait.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(state.connections).toBe(1);
  expect(device.refused).toEqual([]);
});

test("turning the tunnel off reaches the device as a refusal before the connection closes", async () => {
  const { port } = await echo();
  const { tunnel, setEnabled, first } = setup();
  const stream = await tunnel.open(port);
  setEnabled(false);
  await stream.closed;
  await expect.poll(() => first.made[0]?.open).toBe(false);
  // The device heard why: it reports the refusal at once instead of retrying the path.
  expect(await code(tunnel.open(port))).toBe("tunnel_off");
  expect(first.made).toHaveLength(1);
});
