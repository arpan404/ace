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
import { createTunnelHost, type TunnelConnection, type TunnelHost } from "./host.ts";

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
          const copy = bytes.slice();
          queueMicrotask(() => {
            if (state.open) toHost?.(copy);
          });
        },
        close,
      };
    },
  };
  return { path, made };
}

function setup(options: { acePorts?: number[]; listening?: Set<number>; operate?: boolean } = {}) {
  let enabled = true;
  let enabledChanged: ((value: boolean) => void) | undefined;
  const authority = { operate: options.operate ?? true };
  const listening = options.listening ?? new Set<number>();
  const host = createTunnelHost({
    enabled: async () => enabled,
    watchEnabled(changed) {
      enabledChanged = changed;
      return () => {};
    },
    acePorts: async () => new Set(options.acePorts ?? []),
    listening: async () => listening,
    wait: (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(ms, 20));
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    now: () => performance.now(),
    loadMux: async () => attachPreviewRelay,
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
