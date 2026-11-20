import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackTunnel } from "./loopback-tunnel.ts";
import { MachineProxy } from "./socks-server.ts";
import { socksReply } from "./socks5.ts";
import type { MachineTunnel } from "./tunnel-contract.ts";
import { TunnelFailures } from "./tunnel-failure.ts";

/*
 * The proxy over real sockets: a SOCKS5 client as Chromium speaks it, the proxy, a tunnel that
 * reaches this computer's loopback, and a real server on the far side.
 */

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function proxyWith(tunnel: MachineTunnel | undefined) {
  const failures = new TunnelFailures(() => 0);
  const proxy = await MachineProxy.listen({ tunnel: () => tunnel, failures, log: () => {} });
  cleanups.push(() => proxy.close());
  return { proxy, failures };
}

/** Connects through the proxy; resolves with the reply code and the socket, past the reply. */
async function socks(proxyPort: number, host: string, port: number) {
  const socket = connect({ host: "127.0.0.1", port: proxyPort, allowHalfOpen: true });
  cleanups.push(() => socket.destroy());
  const name = Buffer.from(host, "latin1");
  socket.write(Buffer.from([5, 1, 0]));
  socket.write(Buffer.from([5, 1, 0, 3, name.length, ...name, port >> 8, port & 255]));
  const reply = await new Promise<Buffer>((resolve, reject) => {
    let got = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      if (got.length >= 12) {
        socket.off("data", onData);
        socket.pause();
        if (got.length > 12) socket.unshift(got.subarray(12));
        resolve(got);
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => resolve(got));
  });
  expect(Array.from(reply.subarray(0, 2))).toEqual([5, 0]);
  return { code: reply[3], socket };
}

const readAll = (socket: Socket) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.resume();
  });

describe("the machine's localhost proxy", () => {
  it("carries a connection to the machine's port and back, half-close included", async () => {
    // The far side answers only once the browser has finished sending.
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => socket.end(`got:${Buffer.concat(chunks).toString()}`));
    });
    const port = await listen(server);
    const { proxy } = await proxyWith(loopbackTunnel());
    const { code, socket } = await socks(proxy.port, "localhost", port);
    expect(code).toBe(socksReply.succeeded);
    socket.end("hello");
    expect((await readAll(socket)).toString()).toBe("got:hello");
  });

  it("moves a large body both ways without losing or reordering bytes", async () => {
    const server = createServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket));
    const port = await listen(server);
    const { proxy } = await proxyWith(loopbackTunnel());
    const { socket } = await socks(proxy.port, "127.0.0.1", port);
    const body = Buffer.alloc(8 * 1024 * 1024);
    for (let index = 0; index < body.length; index++) body[index] = (index * 31) % 251;
    const echoed = readAll(socket);
    socket.end(body);
    expect((await echoed).equals(body)).toBe(true);
  });

  it("refuses a target that isn't the machine's loopback, without opening a stream", async () => {
    let opened = 0;
    const tunnel = loopbackTunnel();
    const counting: MachineTunnel = {
      ...tunnel,
      open: (port) => {
        opened++;
        return tunnel.open(port);
      },
    };
    const { proxy } = await proxyWith(counting);
    for (const host of ["example.com", "10.0.0.1", "localhost.example.com"]) {
      const { code } = await socks(proxy.port, host, 80);
      expect(code).toBe(socksReply.notAllowed);
    }
    expect(opened).toBe(0);
  });

  it("says why the tunnel refused, and remembers it for the tab", async () => {
    const tunnel = loopbackTunnel({
      refuse: (port) =>
        port === 1111 ? "tunnel_port_refused" : port === 2222 ? "tunnel_off" : undefined,
    });
    const { proxy, failures } = await proxyWith(tunnel);
    expect((await socks(proxy.port, "localhost", 1111)).code).toBe(socksReply.notAllowed);
    expect(failures.recent(1111)).toBe("refused");
    expect((await socks(proxy.port, "localhost", 2222)).code).toBe(socksReply.notAllowed);
    expect(failures.recent(2222)).toBe("off");
  });

  it("answers an unreachable machine as offline", async () => {
    const { proxy, failures } = await proxyWith(undefined);
    expect((await socks(proxy.port, "localhost", 3000)).code).toBe(socksReply.networkUnreachable);
    expect(failures.recent(3000)).toBe("offline");
  });

  it("resets the browser's connection when nothing listens on the machine's port", async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    const { proxy, failures } = await proxyWith(loopbackTunnel());
    const { code, socket } = await socks(proxy.port, "localhost", port);
    expect(code).toBe(socksReply.succeeded);
    await readAll(socket);
    expect(socket.destroyed || socket.readableEnded).toBe(true);
    expect(failures.recent(port)).toBe("closed");
  });

  it("resets the machine's side when the browser's connection is reset", async () => {
    let farClosed!: () => void;
    const closedFar = new Promise<void>((resolve) => (farClosed = resolve));
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.on("close", () => farClosed());
      socket.write("ready");
    });
    const port = await listen(server);
    const { proxy } = await proxyWith(loopbackTunnel());
    const { socket } = await socks(proxy.port, "localhost", port);
    await new Promise((resolve) => {
      socket.once("data", resolve);
      socket.resume();
    });
    socket.resetAndDestroy();
    await closedFar;
  });
});
