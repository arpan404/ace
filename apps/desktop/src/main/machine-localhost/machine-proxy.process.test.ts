import { Agent, createServer as createHttpServer, request, type IncomingMessage } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackTunnel } from "./loopback-tunnel.ts";
import { MachineProxy, type MachineProxyOptions } from "./machine-proxy.ts";
import type { MachineTunnel } from "./tunnel-contract.ts";
import { TunnelFailures } from "./tunnel-failure.ts";

/*
 * The machine's localhost proxy over real sockets: requests as Chromium sends them to an HTTP
 * proxy (CONNECT for HTTPS and websockets, absolute form for plain HTTP), a tunnel that reaches
 * this computer's loopback, and real servers on the far side.
 */

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const secret = "run-secret";
const authorization = (password = secret) =>
  `Basic ${Buffer.from(`ace:${password}`).toString("base64")}`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** A tunnel that counts its opens and hands each one's signal to `signals`. */
function counted(tunnel: MachineTunnel) {
  const signals: AbortSignal[] = [];
  const counting: MachineTunnel = {
    ...tunnel,
    open: (port, options) => {
      if (options?.signal) signals.push(options.signal);
      return tunnel.open(port, options);
    },
  };
  return { tunnel: counting, signals };
}

async function proxyWith(
  tunnel: MachineTunnel | undefined,
  extra: Partial<MachineProxyOptions> = {},
) {
  const failures = new TunnelFailures(() => 0);
  const proxy = await MachineProxy.listen({
    tunnel: () => tunnel,
    failures,
    log: () => {},
    secret,
    ...extra,
  });
  cleanups.push(() => proxy.close());
  return { proxy, failures };
}

/** A CONNECT as Chromium sends one; resolves with the status and, if it went, the socket. */
function tunnelTo(proxyPort: number, authority: string, password: string | null = secret) {
  return new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      headers: password === null ? {} : { "Proxy-Authorization": authorization(password) },
    });
    outgoing.once("connect", (response: IncomingMessage, socket: Socket, head: Buffer) => {
      cleanups.push(() => socket.destroy());
      // Bytes that came with the answer are the machine's first.
      if (head.byteLength) socket.unshift(head);
      resolve({ status: response.statusCode ?? 0, socket });
    });
    outgoing.once("response", (response: IncomingMessage) => {
      cleanups.push(() => response.socket.destroy());
      resolve({ status: response.statusCode ?? 0, socket: response.socket });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

/** A plain-HTTP request in absolute form through the proxy. */
function get(proxyPort: number, url: string, agent?: Agent, password: string | null = secret) {
  return new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>(
    (resolve, reject) => {
      const outgoing = request({
        host: "127.0.0.1",
        port: proxyPort,
        path: url,
        ...(agent ? { agent } : {}),
        headers: {
          Host: new URL(url).host,
          ...(password === null ? {} : { "Proxy-Authorization": authorization(password) }),
        },
      });
      outgoing.once("response", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      outgoing.once("error", reject);
      outgoing.end();
    },
  );
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
  it("refuses any caller without this run's secret, before a stream opens", async () => {
    const server = createServer((socket) => socket.end("machine"));
    const port = await listen(server);
    const { tunnel, signals } = counted(loopbackTunnel());
    const { proxy } = await proxyWith(tunnel);
    expect((await tunnelTo(proxy.port, `localhost:${port}`, null)).status).toBe(407);
    expect((await tunnelTo(proxy.port, `localhost:${port}`, "guess")).status).toBe(407);
    const plain = await get(proxy.port, `http://localhost:${port}/`, undefined, null);
    expect(plain.status).toBe(407);
    expect(plain.headers["proxy-authenticate"]).toBe('Basic realm="ace"');
    // Another process speaking anything else on the port gets nothing through either.
    const raw = connect({ host: "127.0.0.1", port: proxy.port });
    cleanups.push(() => raw.destroy());
    raw.end(Buffer.from([5, 1, 0]));
    await readAll(raw);
    expect(signals).toHaveLength(0);
  });

  it("carries a CONNECT's bytes to the machine's port and back, half-close included", async () => {
    // The far side answers only once the browser has finished sending.
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => socket.end(`got:${Buffer.concat(chunks).toString()}`));
    });
    const port = await listen(server);
    const { proxy } = await proxyWith(loopbackTunnel());
    const { status, socket } = await tunnelTo(proxy.port, `localhost:${port}`);
    expect(status).toBe(200);
    socket.end("hello");
    expect((await readAll(socket)).toString()).toBe("got:hello");
  });

  it("moves a large body both ways through a CONNECT without losing or reordering bytes", async () => {
    const server = createServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket));
    const port = await listen(server);
    const { proxy } = await proxyWith(loopbackTunnel());
    const { socket } = await tunnelTo(proxy.port, `127.0.0.1:${port}`);
    const body = Buffer.alloc(8 * 1024 * 1024);
    for (let index = 0; index < body.length; index++) body[index] = (index * 31) % 251;
    const echoed = readAll(socket);
    socket.end(body);
    expect((await echoed).equals(body)).toBe(true);
  });

  it("sends plain HTTP on in origin form, without its credentials, over one kept stream", async () => {
    const seen: { url: string; authorization: string | undefined; host: string | undefined }[] = [];
    const server = createHttpServer((incoming, response) => {
      seen.push({
        url: incoming.url ?? "",
        authorization: incoming.headers["proxy-authorization"],
        host: incoming.headers.host,
      });
      response.setHeader("Content-Type", "text/plain");
      response.end(`page ${incoming.url}`);
    });
    const port = await listen(server);
    const { tunnel, signals } = counted(loopbackTunnel());
    const { proxy } = await proxyWith(tunnel);
    const browser = new Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => browser.destroy());
    const first = await get(proxy.port, `http://localhost:${port}/app.js?v=1`, browser);
    const second = await get(proxy.port, `http://localhost:${port}/style.css`, browser);
    expect([first.body, second.body]).toEqual(["page /app.js?v=1", "page /style.css"]);
    expect(seen).toEqual([
      { url: "/app.js?v=1", authorization: undefined, host: `localhost:${port}` },
      { url: "/style.css", authorization: undefined, host: `localhost:${port}` },
    ]);
    // The second request reused the first's stream, as a browser's kept connection would.
    expect(signals).toHaveLength(1);
  });

  it("refuses a target that isn't the machine's loopback, without opening a stream", async () => {
    const { tunnel, signals } = counted(loopbackTunnel());
    const { proxy } = await proxyWith(tunnel);
    for (const authority of ["example.com:443", "10.0.0.1:80", "localhost.example.com:80"])
      expect((await tunnelTo(proxy.port, authority)).status).toBe(403);
    expect((await get(proxy.port, "http://example.com/")).status).toBe(403);
    expect(signals).toHaveLength(0);
  });

  it("says why the tunnel refused, and remembers it for the tab", async () => {
    const tunnel = loopbackTunnel({
      refuse: (port) =>
        port === 1111 ? "tunnel_port_refused" : port === 2222 ? "tunnel_off" : undefined,
    });
    const { proxy, failures } = await proxyWith(tunnel);
    expect((await tunnelTo(proxy.port, "localhost:1111")).status).toBe(403);
    expect(failures.recent(1111)).toBe("refused");
    expect((await tunnelTo(proxy.port, "localhost:2222")).status).toBe(403);
    expect(failures.recent(2222)).toBe("off");
  });

  it("answers an unreachable machine as offline, and drops a plain request's connection", async () => {
    const { proxy, failures } = await proxyWith(undefined);
    expect((await tunnelTo(proxy.port, "localhost:3000")).status).toBe(503);
    expect(failures.recent(3000)).toBe("offline");
    // No made-up page: Chromium shows its own error for the load, which the tab explains.
    await expect(get(proxy.port, "http://localhost:3001/")).rejects.toThrow();
    expect(failures.recent(3001)).toBe("offline");
  });

  it("refuses the browser when nothing listens on the machine's port", async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    const { proxy, failures } = await proxyWith(loopbackTunnel());
    expect((await tunnelTo(proxy.port, `localhost:${port}`)).status).toBe(502);
    expect(failures.recent(port)).toBe("closed");
  });

  it("closes a refused connection on time, though the caller neither reads nor closes it", async () => {
    const { proxy } = await proxyWith(loopbackTunnel(), { lingerMs: 200 });
    const raw = connect({ host: "127.0.0.1", port: proxy.port, allowHalfOpen: true });
    cleanups.push(() => raw.destroy());
    raw.on("error", () => {});
    raw.write(`CONNECT localhost:3000 HTTP/1.1\r\nHost: localhost:3000\r\n\r\n`);
    raw.pause();
    const closed = new Promise((resolve) => raw.once("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Past the deadline the proxy's side is gone: what the caller sends now is reset. The reset
    // for one write arrives after it, so keep writing, a little apart, until the close lands.
    const writing = setInterval(() => {
      if (!raw.destroyed) raw.write("still here");
    }, 20);
    cleanups.push(() => clearInterval(writing));
    await closed;
  });

  it("gives up an open the machine doesn't answer by its deadline, cancelling it", async () => {
    const { tunnel, signals } = counted(loopbackTunnel({ hold: () => new Promise(() => {}) }));
    const { proxy, failures } = await proxyWith(tunnel, { openMs: 150 });
    expect((await tunnelTo(proxy.port, "localhost:3000")).status).toBe(503);
    expect(failures.recent(3000)).toBe("offline");
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("gives up the open when the browser goes away while it waits", async () => {
    const { tunnel, signals } = counted(loopbackTunnel({ hold: () => new Promise(() => {}) }));
    const { proxy, failures } = await proxyWith(tunnel);
    const raw = connect({ host: "127.0.0.1", port: proxy.port });
    raw.on("error", () => {});
    raw.write(`CONNECT localhost:3000 HTTP/1.1\r\nProxy-Authorization: ${authorization()}\r\n\r\n`);
    await expect.poll(() => signals.length).toBe(1);
    raw.destroy();
    await expect.poll(() => signals[0]?.aborted).toBe(true);
    // The browser left: nothing about the machine to explain.
    expect(failures.recent(3000)).toBeUndefined();
  });

  it("gives up a plain request's open when the browser goes away while it waits", async () => {
    const { tunnel, signals } = counted(loopbackTunnel({ hold: () => new Promise(() => {}) }));
    const { proxy, failures } = await proxyWith(tunnel);
    const raw = connect({ host: "127.0.0.1", port: proxy.port });
    raw.on("error", () => {});
    raw.write(
      `GET http://localhost:3000/ HTTP/1.1\r\nHost: localhost:3000\r\nProxy-Authorization: ${authorization()}\r\n\r\n`,
    );
    await expect.poll(() => signals.length).toBe(1);
    raw.destroy();
    await expect.poll(() => signals[0]?.aborted).toBe(true);
    expect(failures.recent(3000)).toBeUndefined();
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
    const { socket } = await tunnelTo(proxy.port, `localhost:${port}`);
    await new Promise((resolve) => {
      socket.once("data", resolve);
      socket.resume();
    });
    socket.resetAndDestroy();
    await closedFar;
  });
});
