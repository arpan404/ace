// SPDX-License-Identifier: Apache-2.0
/*
 * The proof test of the transport port (ADR 0226, T1a.8). No test covered these before it: the
 * proxy guard on its own, who a `/v1/stop` caller turns out to be once its request crossed the
 * hop, and the close codes a native socket must reproduce. Some assertions hold on both legs, so
 * this file must pass with `ACE_TRANSPORT` off and on; the ones only the native path can reach
 * run under `transportParts().has("loopback")` and the proof run proves that leg by its evidence
 * file.
 *
 * Which socket a case drives is itself a leg: with the switch off the daemon's own `ws` socket,
 * with it on the Rust listener's socket behind `NativeSocket`. `socketPair` gives a test the
 * daemon-side `MainSocket` and a `ws` client, from whichever implementation is running.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { transportParts } from "@ace/provider-kit/native-switches";
import { transportAddon, type NativeSocketHandle } from "@ace/provider-kit/native-transport";
import { systemListing } from "@ace/provider-kit/process-listing";
import { peerOf } from "./http-peer.ts";
import type { MainSocket } from "./main-socket.ts";
import { NativeSocket } from "./native-socket.ts";
import { verifiedCaller } from "./peer-process.ts";
import { proxyGuard } from "./proxy-guard.ts";
import { shutdownControl } from "./shutdown-receipt.ts";
import { fixture, token, type Client } from "./socket-test-support.ts";

const MIB = 1024 * 1024;
const HOP_SECRET = "proof-secret-0123456789";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The six headers the hop reserves; a valid request carries one value of the first four. */
function hopHeaders(
  secret = HOP_SECRET,
  peer = { address: "127.0.0.1", port: 4, local: 5 },
  servername?: string,
) {
  return {
    "x-ace-hop-secret": secret,
    "x-ace-hop-peer-address": peer.address,
    "x-ace-hop-peer-port": String(peer.port),
    "x-ace-hop-local-port": String(peer.local),
    ...(servername === undefined ? {} : { "x-ace-hop-servername": servername }),
  };
}

/** One request to a local HTTP server, its status, and its body. */
function statusOf(
  port: number,
  headers: Record<string, string | string[]>,
  localAddress?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/guarded",
        method: "GET",
        headers,
        agent: false,
        ...(localAddress === undefined ? {} : { localAddress }),
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/** One request written as raw bytes, its status read from the first line: header names can repeat in case. */
function rawStatus(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let answer = "";
    socket.setEncoding("latin1");
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      answer += chunk;
    });
    socket.once("end", () => resolve(Number(answer.split(" ")[1])));
    socket.once("error", reject);
  });
}

/** A `node:http` server around the guard, with a handler that records what it was given. */
async function guarded() {
  const reached: {
    peer: ReturnType<typeof peerOf>;
    headers: Record<string, unknown>;
    rawHeaders: string[];
  }[] = [];
  const server = createHttpServer(
    proxyGuard(HOP_SECRET, (request, response) => {
      reached.push({
        peer: peerOf(request),
        headers: { ...request.headers },
        rawHeaders: [...request.rawHeaders],
      });
      response.writeHead(200, { "Content-Length": "0" }).end();
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => void server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No guard address");
  return { port: address.port, reached };
}

/** A non-loopback IPv4 this machine has, or undefined where it has none. */
function outsideAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
  return undefined;
}

/** The daemon and the client it gave me: one socket per leg, whichever side implements it. */
interface Pair {
  server: MainSocket;
  client: WebSocket;
}

/**
 * One socket pair. Off, a local `ws` server stands where the daemon's listener stands; on, the
 * Rust listener does, and its handle is wrapped exactly as the daemon wraps it (`NativeSocket`).
 */
async function socketPair(): Promise<Pair> {
  const serverOpened = Promise.withResolvers<MainSocket>();
  let port: number;
  let close: () => Promise<void>;
  if (transportParts().has("loopback")) {
    const addon = transportAddon();
    const listener = await addon.NativeLoopback.start(
      {
        port: 0,
        targetPort: 9,
        secretHex: addon.NativeLoopback.generateSecret(),
        admitTimeoutMs: 1_000,
      },
      // Admission is this pair's own: every upgrade opens.
      async () => ({ decision: "accept", reservation: 1 }),
      () => {},
      (handle) => serverOpened.resolve(new NativeSocket(handle)),
    );
    port = listener.port();
    close = () => listener.close(0);
  } else {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: MIB });
    await once(wss, "listening");
    wss.once("connection", (socket) => serverOpened.resolve(socket as unknown as MainSocket));
    const address = wss.address();
    if (address === null || typeof address === "string")
      throw new Error("No socket server address");
    port = address.port;
    close = () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      });
  }
  cleanups.push(close);
  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  cleanups.push(() => client.terminate());
  await once(client, "open");
  const server = await serverOpened.promise;
  // What the daemon does with every socket it registers: a peer's reset is an `error` before its
  // `close`, and an unobserved one would end the worker.
  server.on("error", () => {});
  return { server, client };
}

/** A close code, from whichever side reports it. */
function closed(socket: MainSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

it("the proxy guard refuses everything that did not come through the hop, and only admits a valid hop", async () => {
  const { port, reached } = await guarded();
  // No secret, a wrong one, and one sent twice: all refused before the handler.
  expect(await statusOf(port, {})).toBe(403);
  expect(await statusOf(port, hopHeaders("not-the-secret"))).toBe(403);
  expect(
    await statusOf(port, { ...hopHeaders(), "x-ace-hop-secret": [HOP_SECRET, HOP_SECRET] }),
  ).toBe(403);
  // A missing, malformed or out-of-range peer field is refused too.
  expect(await statusOf(port, { ...hopHeaders(), "x-ace-hop-peer-port": "0" })).toBe(403);
  expect(await statusOf(port, { ...hopHeaders(), "x-ace-hop-local-port": "not-a-port" })).toBe(403);
  expect(await statusOf(port, { ...hopHeaders(), "x-ace-hop-peer-address": "not-an-ip" })).toBe(
    403,
  );
  // A trust marker on a request never came from the hop: Rust removes every client copy.
  expect(await statusOf(port, { ...hopHeaders(), "x-ace-hop-trust": "1" })).toBe(403);
  expect(await statusOf(port, { ...hopHeaders(), "X-Ace-Hop-Trust": "1" })).toBe(403);
  // Two server names, differing only in case, are two values: refused. Written raw, because a
  // Node client normalises a header name and would send one.
  expect(
    await rawStatus(
      port,
      [
        "GET /guarded HTTP/1.1",
        "Host: 127.0.0.1",
        `x-ace-hop-secret: ${HOP_SECRET}`,
        "x-ace-hop-peer-address: 127.0.0.1",
        "x-ace-hop-peer-port: 4",
        "x-ace-hop-local-port: 5",
        "x-ace-hop-servername: studio.tail1234.ts.net",
        "X-Ace-Hop-Servername: studio.tail1234.ts.net",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    ),
  ).toBe(403);
  // A name rustls could not have handed over is refused.
  expect(await statusOf(port, { ...hopHeaders(), "x-ace-hop-servername": "Not A Name" })).toBe(403);
  expect(await statusOf(port, { ...hopHeaders(), "x-ace-hop-servername": "" })).toBe(403);
  expect(await statusOf(port, { ...hopHeaders(), "x-ace-hop-servername": "x".repeat(254) })).toBe(
    403,
  );
  expect(reached).toEqual([]);
  // A valid hop reaches the chain, without the six headers, with the peer it recorded.
  expect(await statusOf(port, hopHeaders())).toBe(200);
  expect(await statusOf(port, hopHeaders(HOP_SECRET, undefined, "studio.tail1234.ts.net"))).toBe(
    200,
  );
  expect(reached).toHaveLength(2);
  expect(reached[0]?.peer).toEqual({
    address: "127.0.0.1",
    remotePort: 4,
    localPort: 5,
    servername: null,
    viaHop: true,
  });
  expect(reached[1]?.peer.servername).toBe("studio.tail1234.ts.net");
  for (const record of reached) {
    for (const name of Object.keys(hopHeaders())) expect(record.headers[name]).toBeUndefined();
    expect(record.rawHeaders.map((value) => value.toLowerCase())).not.toContain(
      "x-ace-hop-servername",
    );
    expect(record.rawHeaders.map((value) => value.toLowerCase())).not.toContain("x-ace-hop-trust");
  }
});

// The guard refuses a peer that did not arrive over loopback; the case needs an interface the
// request can come from, so a machine with only loopback skips it with that reason.
it.skipIf(outsideAddress() === undefined)(
  "a request from a non-loopback peer is refused even carrying a valid hop",
  async () => {
    const outside = outsideAddress();
    if (outside === undefined) throw new Error("skipIf should have skipped: no outside address");
    const server = createHttpServer(
      proxyGuard(HOP_SECRET, (_request, response) => {
        response.writeHead(200, { "Content-Length": "0" }).end();
      }),
    );
    server.listen(0, "0.0.0.0");
    await once(server, "listening");
    cleanups.push(() => void server.close());
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No guard address");
    const request = httpRequest({
      host: outside,
      port: address.port,
      path: "/guarded",
      headers: hopHeaders(),
      agent: false,
    });
    const status = new Promise<number>((resolve, reject) => {
      request.once("response", (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
    });
    request.end();
    expect(await status).toBe(403);
  },
);

it.runIf(transportParts().has("loopback"))(
  "a request straight to the internal hop port is refused without the secret",
  async () => {
    const f = await fixture();
    cleanups.push(() => f.close());
    const internal = f.server.internalHttpUrl;
    expect(internal).toBeDefined();
    if (internal === undefined) return;
    const port = Number(new URL(internal).port);
    expect(await statusOf(port, {})).toBe(403);
  },
);

/** A process's caller hint: itself and its ancestors by pid and kernel start. */
type Member = { pid: number; start: string };

/**
 * A shutdown control that records every stop request's verified caller. The daemon's `request`
 * callback runs once per control, so each request builds its own (still `shutdownControl`); the
 * verifier is the daemon's own and `start` leaves the proof's daemon running.
 */
function recordingShutdown(home: string, received: Member[][]) {
  return {
    verifyCaller: (
      hint: readonly Member[] | undefined,
      connection: { remotePort: number; localPort: number },
    ) => verifiedCaller(hint, connection, systemListing),
    request(body?: { caller?: Member[] }) {
      return shutdownControl(home, {
        id: () => "proof-stop",
        now: () => Date.now(),
        close: async () => {},
        caller: (members) => {
          received.push(members);
        },
      }).request(body);
    },
    start() {},
  };
}

/**
 * A real child process posts `/v1/stop` to the public port carrying its own chain. `hint` says
 * what it claims: itself (verified), or the test's own process (which holds no such connection).
 * Returns the child's pid and exit status.
 */
async function stopFromChild(options: {
  port: number;
  hint: "own" | "test";
  forge: boolean;
}): Promise<{ pid: number | undefined; status: number | null }> {
  const work = mkdtempSync(join(tmpdir(), "ace-caller-"));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  const listing = pathToFileURL(
    join(import.meta.dirname, "../../../packages/provider-kit/src/process-listing.ts"),
  ).href;
  const self = systemListing.info(process.pid);
  const hint =
    options.hint === "own"
      ? "chain"
      : JSON.stringify([{ pid: process.pid, start: self?.start ?? "unknown" }]);
  const forged = options.forge
    ? `"x-ace-hop-secret": "forged", "x-ace-hop-peer-address": "203.0.113.9", "x-ace-hop-peer-port": "1", "x-ace-hop-local-port": "2",`
    : "";
  const script = `
    import { request } from "node:http";
    import { lineage, systemListing } from ${JSON.stringify(listing)};
    const chain = [...lineage(process.pid, systemListing)].flatMap((pid) => {
      const info = systemListing.info(pid);
      return info && !info.zombie ? [{ pid, start: info.start }] : [];
    });
    const body = JSON.stringify({ caller: ${hint} });
    const req = request({
      host: "127.0.0.1",
      port: ${options.port},
      path: "/v1/stop",
      method: "POST",
      headers: {
        authorization: "Bearer ${token}",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ${forged}
      },
    }, (response) => {
      response.resume();
      response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
    });
    req.on("error", () => process.exit(1));
    req.end(body);
  `;
  const file = join(work, "caller.ts");
  writeFileSync(file, script);
  // Asynchronous on purpose: the daemon answering that request runs in this process, so a
  // blocking spawn would deadlock the connection the child is waiting on.
  const child = spawn(process.execPath, [file], { stdio: "ignore" });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const status = await exited;
  clearTimeout(timer);
  return { pid: child.pid, status };
}

it("a stop request's caller is the process holding the connection, through the hop", async () => {
  const received: Member[][] = [];
  // `peer-process.ts` verifies nobody on Windows (no peer credentials and no lsof), so there the
  // verified chain is empty on every hint.
  const verifies = process.platform !== "win32";
  const f = await fixture({}, (_store, home) => ({ shutdown: recordingShutdown(home, received) }));
  cleanups.push(() => f.close());
  const port = Number(new URL(f.server.httpUrl).port);

  const own = await stopFromChild({ port, hint: "own", forge: false });
  expect(own.status).toBe(0);
  expect(received).toHaveLength(1);
  expect(received[0]?.[0]?.pid).toBe(verifies ? own.pid : undefined);

  // The child's own forged hop ports are replaced by the hop's real ones, so the chain stands.
  const forged = await stopFromChild({ port, hint: "own", forge: true });
  expect(forged.status).toBe(0);
  expect(received).toHaveLength(2);
  expect(received[1]?.[0]?.pid).toBe(verifies ? forged.pid : undefined);

  // A hint naming a process that doesn't hold this connection spares nobody.
  const wrong = await stopFromChild({ port, hint: "test", forge: false });
  expect(wrong.status).toBe(0);
  expect(received).toHaveLength(3);
  expect(received[2]).toEqual([]);
});

it("a message over 1 MiB closes the peer's socket with 1009", async () => {
  const { client } = await socketPair();
  const code = new Promise<number>((resolve) => client.once("close", (ended) => resolve(ended)));
  client.send("x".repeat(MIB + 1));
  expect(await code).toBe(1009);
});

it("a peer that drops the TCP connection is reported as 1006", async () => {
  const { server, client } = await socketPair();
  const code = closed(server);
  client.terminate();
  expect(await code).toBe(1006);
});

it("a send while closing reports CLOSING, as ws does", async () => {
  const { server } = await socketPair();
  server.close(1000, "bye");
  const message = await new Promise<string>((resolve) => {
    server.send("during close", (error) => resolve(error?.message ?? ""));
  });
  expect(message).toBe("WebSocket is not open: readyState 2 (CLOSING)");
});

it.runIf(transportParts().has("loopback"))(
  "a send after the peer's close frame, before its close event, sees CLOSING",
  async () => {
    const addon = transportAddon();
    const opened = Promise.withResolvers<NativeSocketHandle>();
    const listener = await addon.NativeLoopback.start(
      {
        port: 0,
        targetPort: 9,
        secretHex: addon.NativeLoopback.generateSecret(),
        admitTimeoutMs: 1_000,
      },
      async () => ({ decision: "accept", reservation: 1 }),
      () => {},
      (handle) => opened.resolve(handle),
    );
    cleanups.push(() => listener.close(0));
    const client = new WebSocket(`ws://127.0.0.1:${listener.port()}/`);
    cleanups.push(() => client.terminate());
    await once(client, "open");
    const handle = await opened.promise;
    const peerGone = once(client, "close");
    client.send("message before the close");
    client.close();
    // Nothing listens yet, so Rust queues both frames and has sealed by the time the client
    // sees its close. Wrapping now delivers the queued message first: the send there happens
    // after the peer's close frame and before this socket's `close` event.
    await peerGone;
    const server = new NativeSocket(handle);
    const order: string[] = [];
    const failure = new Promise<string>((resolve) => {
      server.on("message", () => {
        order.push("message");
        server.send("reply", (error) => {
          order.push("callback");
          resolve(error?.message ?? "");
        });
      });
      server.once("close", () => order.push("close"));
    });
    expect(await failure).toBe("WebSocket is not open: readyState 2 (CLOSING)");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(["message", "callback", "close"]);
  },
);

it.runIf(transportParts().has("loopback"))(
  "a refused enqueue while Rust has closed reports CLOSING, never CLOSED",
  async () => {
    let native = 1;
    const handle: NativeSocketHandle = {
      listen: () => {},
      send: () => {
        // Rust seals between the state check and the enqueue.
        native = 3;
        return "not-open";
      },
      close: () => {},
      terminate: () => {},
      pause: () => {},
      resume: () => {},
      isPaused: () => false,
      bufferedAmount: () => 0,
      readyState: () => native,
    };
    const socket = new NativeSocket(handle);
    const message = await new Promise<string>((resolve) => {
      socket.send("during the seal", (error) => resolve(error?.message ?? ""));
    });
    expect(message).toBe("WebSocket is not open: readyState 2 (CLOSING)");
  },
);

it("a send after close calls back once with an error on the next tick, through both overloads", async () => {
  const { server, client } = await socketPair();
  const code = closed(server);
  client.close();
  await code;
  const order: string[] = [];
  const calls: { label: string; error: Error | undefined; sync: boolean }[] = [];
  await new Promise<void>((resolve) => {
    let sync = true;
    const finish = (label: string, error?: Error) => {
      calls.push({ label, error, sync });
      order.push(label);
      if (calls.length === 2) resolve();
    };
    server.send("after close", (error) => finish("first", error));
    server.send(Buffer.from("after close"), { binary: true }, (error) => finish("second", error));
    sync = false;
    // ws's send-after-close queues its error on the next tick, so both callbacks run before this.
    process.nextTick(() => order.push("marker"));
  });
  expect(calls.every((call) => call.sync === false)).toBe(true);
  expect(calls.every((call) => call.error instanceof Error)).toBe(true);
  expect(order.slice(0, 2).toSorted()).toEqual(["first", "second"]);
  expect(order[2]).toBe("marker");
});

it("binary bytes arrive binary, and bytes sent as text arrive text", async () => {
  const { server, client } = await socketPair();
  const frames: { data: string; binary: boolean }[] = [];
  const both = new Promise<void>((resolve) => {
    client.on("message", (data, isBinary) => {
      frames.push({ data: data.toString(), binary: isBinary });
      if (frames.length === 2) resolve();
    });
  });
  server.send(Buffer.from("binary-frame"));
  server.send(Buffer.from("text-frame"), { binary: false });
  await both;
  expect(frames).toEqual([
    { data: "binary-frame", binary: true },
    { data: "text-frame", binary: false },
  ]);
});

it("shutdown closes an open socket with 1001", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const client: Client = await f.connect();
  await client.next();
  const code = once(client.socket, "close");
  await f.server.close();
  expect((await code)[0]).toBe(1001);
});

/** One upgrade request's raw bytes for `/`, with a valid key. */
function upgradeRequest(target = "/"): string {
  return [
    `GET ${target} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

it("an upgrade to another path is dropped without an answer", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const socket = connect(Number(new URL(f.server.url).port), "127.0.0.1");
  cleanups.push(() => {
    socket.destroy();
  });
  await once(socket, "connect");
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  socket.write(upgradeRequest("/?x"));
  const outcome = await Promise.race([
    once(socket, "close").then(() => "closed" as const),
    new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 4_000)),
  ]);
  expect(outcome).toBe("closed");
  expect(received).toBe("");
});

it("an upgrade after an ordinary request on a keep-alive connection opens a socket", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const socket = connect(Number(new URL(f.server.url).port), "127.0.0.1");
  cleanups.push(() => {
    socket.destroy();
  });
  await once(socket, "connect");
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  const waitFor = (needle: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${needle} in: ${received}`)), 5_000);
      const check = () => {
        if (!received.includes(needle)) return;
        clearTimeout(timer);
        socket.off("data", check);
        resolve();
      };
      socket.on("data", check);
      check();
    });
  socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
  await waitFor("\r\n\r\n");
  socket.write(upgradeRequest("/"));
  await waitFor("101 Switching Protocols");
});
