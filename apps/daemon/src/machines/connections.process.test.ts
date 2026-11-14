import { createConnection, createServer, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach, expect, test } from "vitest";
import { DeviceId, HostId, MachineCallRequest, ThreadId, type MachineCall } from "@ace/protocol";
import { systemDeliveryRuntime } from "../delivery-runtime.ts";
import { tlsFixtureHome } from "../process-test-support.ts";
import { sniListener, type SniLimits } from "../sni-listener.ts";
import { loadIdentity } from "../tls-identity.ts";
import { MachineConnections } from "./connections.ts";
import { MachineFailure, machineRequest, pinnedRequest } from "./transport.ts";
import { machineCallsHttp } from "./http.ts";

// Real TLS sockets on a real listener: reuse, resumption and pinning live in the socket layers.
const identity = loadIdentity(tlsFixtureHome());
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const schedule = (ms: number, run: () => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** A listener answering `{}`, recording the connection and token each request came on. */
async function machine(limits: Partial<SniLimits> = {}) {
  const sockets: TLSSocket[] = [];
  const tokens: string[] = [];
  const listener = sniListener({
    tls: identity,
    requests: (request, response) => {
      const socket = request.socket as TLSSocket;
      if (!sockets.includes(socket)) sockets.push(socket);
      tokens.push(request.headers.authorization ?? "");
      request.resume();
      request.on("end", () => response.writeHead(200).end("{}"));
    },
    delay: systemDeliveryRuntime.delay,
    log: () => {},
    limits,
  });
  const port = await listener.listen("127.0.0.1", 0);
  cleanups.push(() => listener.close());
  return { origin: `https://127.0.0.1:${port}/`, sockets, tokens };
}

const pool = () => {
  const connections = new MachineConnections({ schedule });
  cleanups.push(() => connections.close());
  return connections;
};

const call = (
  profile: { origin: string; fingerprint: string; token: string },
  connections?: MachineConnections,
) =>
  pinnedRequest(
    profile,
    { path: "/v1/machine-calls", method: "POST", body: "{}", contentType: "application/json" },
    { timeoutMs: 5000, ...(connections ? { connections } : {}) },
  );

const token = (digit: string) => digit.repeat(64);

test("ten calls to one machine share one pinned connection", async () => {
  const target = await machine();
  const connections = pool();
  const profile = { origin: target.origin, fingerprint: identity.fingerprint, token: token("a") };
  for (let i = 0; i < 10; i++) await expect(call(profile, connections)).resolves.toEqual({});
  expect(target.sockets).toHaveLength(1);
  expect(target.tokens).toHaveLength(10);
});

test("a call without the pool opens its own connection each time, as older callers do", async () => {
  const target = await machine();
  const profile = { origin: target.origin, fingerprint: identity.fingerprint, token: token("a") };
  for (let i = 0; i < 3; i++) await call(profile);
  expect(target.sockets).toHaveLength(3);
});

test("a new token after re-pairing opens a new connection, never the old socket", async () => {
  const target = await machine();
  const connections = pool();
  const before = { origin: target.origin, fingerprint: identity.fingerprint, token: token("a") };
  const after = { ...before, token: token("b") };
  await call(before, connections);
  connections.retain([after]);
  await call(after, connections);
  await call(after, connections);
  expect(target.sockets).toHaveLength(2);
  expect(target.tokens).toEqual([`Bearer ${token("a")}`, ...Array(2).fill(`Bearer ${token("b")}`)]);
  // The first pairing's socket was closed when it was dropped, not left open.
  await expect.poll(() => target.sockets[0]?.destroyed).toBe(true);
});

test("a changed pin is checked on a new connection, so an open one is never reused for it", async () => {
  const target = await machine();
  const connections = pool();
  const good = { origin: target.origin, fingerprint: identity.fingerprint, token: token("a") };
  await call(good, connections);
  const other = { ...good, fingerprint: "0".repeat(64) };
  const failure = await call(other, connections).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MachineFailure);
  expect((failure as MachineFailure).kind).toBe("offline");
  // The refused handshake never carried a request.
  expect(target.tokens).toHaveLength(1);
});

test("an idle connection closes before the machine's own limit, and the next one resumes TLS", async () => {
  // The machine keeps idle connections 2.5 s and says so; the caller lets go of them first.
  const target = await machine({ keepAlive: 2500 });
  const connections = pool();
  const profile = { origin: target.origin, fingerprint: identity.fingerprint, token: token("a") };
  await call(profile, connections);
  await expect.poll(() => target.sockets[0]?.destroyed, { timeout: 2000 }).toBe(true);
  await expect(call(profile, connections)).resolves.toEqual({});
  expect(target.sockets).toHaveLength(2);
  expect(target.sockets[1]?.isSessionReused()).toBe(true);
});

/**
 * A machine running this build's `/v1/machine-calls` handler: browser calls take `slowMs` to
 * answer, anything else answers at once; each call's arrival time is recorded by op.
 */
async function busyMachine(slowMs: number) {
  const arrived: { op: string; at: number }[] = [];
  const handler = machineCallsHttp(
    () => ({
      handle: async (_device, body) => {
        const op = MachineCallRequest.parse(body).call.op;
        arrived.push({ op, at: Date.now() });
        if (op === "browser") await new Promise((resolve) => setTimeout(resolve, slowMs));
        return { status: 200, body: { ok: true } };
      },
    }),
    (presented) =>
      presented === token("a")
        ? {
            id: DeviceId.parse("device-1"),
            name: "MacBook",
            scopes: ["read", "operate"],
            createdAt: 0,
            lastSeenAt: 0,
            revokedAt: null,
          }
        : undefined,
    (_request, response) => response.writeHead(404).end(),
  );
  const listener = sniListener({
    tls: identity,
    requests: handler,
    delay: systemDeliveryRuntime.delay,
    log: () => {},
  });
  const port = await listener.listen("127.0.0.1", 0);
  cleanups.push(() => listener.close());
  return {
    arrived,
    profile: {
      id: "5b0f3f4e-8f3a-4b8e-9d3c-2f6a1c7e9b10",
      name: "studio",
      origin: `https://127.0.0.1:${port}/`,
      fingerprint: identity.fingerprint,
      deviceId: DeviceId.parse("device-1"),
      token: token("a"),
    },
  };
}

const origin = {
  hostId: HostId.parse("host-1"),
  hostName: "MacBook",
  threadId: ThreadId.parse("parent"),
  threadTitle: "Parent",
  ceiling: "operate" as const,
};
const browserCall: MachineCall = { op: "browser", tool: "browser_snapshot", args: {} };

test("a cancel reaches its machine at once while long tool calls hold every shared connection", async () => {
  const target = await busyMachine(3000);
  const connections = pool();
  const long = Array.from({ length: 8 }, () =>
    machineRequest(target.profile, { origin, call: browserCall }, { timeoutMs: 10_000, connections }),
  );
  await expect.poll(() => target.arrived.length).toBeGreaterThanOrEqual(6);
  const sent = Date.now();
  await expect(
    machineRequest(
      target.profile,
      { origin, call: { op: "cancel", threadId: ThreadId.parse("child-1") } },
      { timeoutMs: 1500, connections },
    ),
  ).resolves.toEqual({ ok: true });
  const cancel = target.arrived.find((entry) => entry.op === "cancel");
  expect((cancel?.at ?? Infinity) - sent).toBeLessThan(1000);
  await Promise.all(long);
});

test("a call waiting for a free connection is timed from when it is sent, not while it waits", async () => {
  const target = await busyMachine(1500);
  const connections = pool();
  const long = Array.from({ length: 6 }, () =>
    machineRequest(target.profile, { origin, call: browserCall }, { timeoutMs: 10_000, connections }),
  );
  await expect.poll(() => target.arrived.length).toBe(6);
  // It waits about 1.5 s for a connection, longer than its own 1 s, and still gets its answer.
  await expect(
    machineRequest(
      target.profile,
      { origin, call: { op: "status", threadIds: [ThreadId.parse("child-1")] } },
      { timeoutMs: 1000, connections },
    ),
  ).resolves.toEqual({ ok: true });
  await Promise.all(long);
});

/**
 * A TCP proxy to `port` that can cut its open connections the way an expired NAT entry does: the
 * caller still holds them open, and the first bytes it sends are answered with a reset.
 */
async function cuttingProxy(port: number) {
  const open = new Set<Socket>();
  const state = { cut: false, connections: 0 };
  const server = createServer((client) => {
    state.connections++;
    const upstream = createConnection({ host: "127.0.0.1", port });
    const pair = { client, upstream, cut: false };
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => open.delete(socket));
    }
    client.on("data", (chunk: Buffer) => {
      if (pair.cut) {
        client.resetAndDestroy();
        upstream.destroy();
      } else upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    cuts.add(pair);
  });
  const cuts = new Set<{ client: Socket; upstream: Socket; cut: boolean }>();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy not listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    origin: `https://127.0.0.1:${address.port}/`,
    state,
    /** Every connection open now is dropped on the network side; new ones work. */
    cutAll() {
      for (const pair of cuts) pair.cut = true;
    },
  };
}

test("a status read on a kept-open connection the network dropped goes again on a fresh one", async () => {
  const target = await busyMachine(0);
  const proxy = await cuttingProxy(Number(new URL(target.profile.origin).port));
  const profile = { ...target.profile, origin: proxy.origin };
  const connections = pool();
  const read = { origin, call: { op: "status" as const, threadIds: [ThreadId.parse("child-1")] } };
  await machineRequest(profile, read, { timeoutMs: 5000, connections });
  proxy.cutAll();
  await expect(machineRequest(profile, read, { timeoutMs: 5000, connections })).resolves.toEqual({
    ok: true,
  });
  expect(proxy.state.connections).toBe(2);
});

test("work sent on a dropped connection is never sent again on its own", async () => {
  const target = await busyMachine(0);
  const proxy = await cuttingProxy(Number(new URL(target.profile.origin).port));
  const profile = { ...target.profile, origin: proxy.origin };
  const connections = pool();
  await machineRequest(
    profile,
    { origin, call: { op: "status", threadIds: [ThreadId.parse("child-1")] } },
    { timeoutMs: 5000, connections },
  );
  proxy.cutAll();
  const failure = await machineRequest(
    profile,
    {
      origin,
      call: {
        op: "message",
        threadId: ThreadId.parse("child-1"),
        requestId: "follow-up",
        text: "Run the tests again",
        delivery: "queue",
      },
    },
    { timeoutMs: 5000, connections },
  ).catch((error: unknown) => error);
  // The caller hears the connection was lost; its own retry rules decide what happens next.
  expect(failure).toBeInstanceOf(MachineFailure);
  expect((failure as MachineFailure).kind).toBe("disconnected");
  expect(target.arrived.map((entry) => entry.op)).toEqual(["status"]);
  expect(proxy.state.connections).toBe(1);
});
