import { createConnection, createServer, type Socket } from "node:net";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { afterEach, expect, test } from "vitest";
import {
  DeviceId,
  HostId,
  InteractionId,
  MachineCallRequest,
  ThreadId,
  type MachineCall,
} from "@ace/protocol";
import { systemDeliveryRuntime } from "../delivery-runtime.ts";
import { tlsFixtureHome } from "../process-test-support.ts";
import { sniListener, type SniLimits } from "../sni-listener.ts";
import { loadIdentity } from "../tls-identity.ts";
import { pinnedKeepAliveAgent } from "../client-access.ts";
import { MachineConnections } from "./connections.ts";
import { MachineFailure, MachineNotSent, machineRequest, pinnedRequest } from "./transport.ts";
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

const isBrowser = (asked: MachineCall) => asked.op === "browser";

/**
 * A machine running this build's `/v1/machine-calls` handler: browser calls take `slowMs` to
 * answer, anything else answers at once; each call's arrival time is recorded by op.
 */
async function busyMachine(slowMs: number, slow: (asked: MachineCall) => boolean = isBrowser) {
  const arrived: { op: string; at: number }[] = [];
  const handler = machineCallsHttp(
    () => ({
      handle: async (_device, body) => {
        const asked = MachineCallRequest.parse(body).call;
        arrived.push({ op: asked.op, at: Date.now() });
        if (slow(asked)) await new Promise((resolve) => setTimeout(resolve, slowMs));
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
  const sockets = new Set<TLSSocket>();
  const listener = sniListener({
    tls: identity,
    requests: (request, response) => {
      sockets.add(request.socket as TLSSocket);
      handler(request, response);
    },
    delay: systemDeliveryRuntime.delay,
    log: () => {},
  });
  const port = await listener.listen("127.0.0.1", 0);
  cleanups.push(() => listener.close());
  return {
    arrived,
    sockets,
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
    machineRequest(
      target.profile,
      { origin, call: browserCall },
      { timeoutMs: 10_000, connections },
    ),
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

test("a call that never gets a connection fails at its own deadline, saying it was never sent", async () => {
  const target = await busyMachine(3000);
  const connections = pool();
  const long = Array.from({ length: 6 }, () =>
    machineRequest(
      target.profile,
      { origin, call: browserCall },
      { timeoutMs: 10_000, connections },
    ),
  );
  await expect.poll(() => target.arrived.length).toBe(6);
  const started = Date.now();
  const failure = await machineRequest(
    target.profile,
    { origin, call: { op: "status", threadIds: [ThreadId.parse("child-1")] } },
    { timeoutMs: 1000, connections },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MachineNotSent);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(target.arrived.map((entry) => entry.op)).not.toContain("status");
  await Promise.all(long);
});

test("an answer to the person reaches its machine at once while stops hold the urgent connections", async () => {
  const stop: MachineCall = { op: "commands", tool: "command_stop", args: { jobId: "job-1" } };
  const target = await busyMachine(4000, (asked) => asked.op === "commands");
  const connections = pool();
  const stops = Array.from({ length: 2 }, () =>
    machineRequest(target.profile, { origin, call: stop }, { timeoutMs: 25_000, connections }),
  );
  await expect.poll(() => target.arrived.length).toBe(2);
  const sent = Date.now();
  await expect(
    machineRequest(
      target.profile,
      {
        origin,
        call: {
          op: "respond",
          threadId: ThreadId.parse("child-1"),
          interactionId: InteractionId.parse("ask-1"),
          resolution: { kind: "approval", optionId: "allow" },
        },
      },
      { timeoutMs: 15_000, connections },
    ),
  ).resolves.toEqual({ ok: true });
  const respond = target.arrived.find((entry) => entry.op === "respond");
  expect((respond?.at ?? Infinity) - sent).toBeLessThan(1000);
  await Promise.all(stops);
});

/**
 * A TCP proxy to `port` that can cut its open connections the way an expired NAT entry does: the
 * caller still holds them open, and the first bytes it sends are answered with a reset.
 */
async function cuttingProxy(port: number, resetAfterMs = 0) {
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
        const reset = () => {
          client.resetAndDestroy();
          upstream.destroy();
        };
        if (resetAfterMs > 0) setTimeout(reset, resetAfterMs);
        else reset();
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

/** This build's machine-calls listener with the given limits, answering every call at once. */
async function limitedMachine(limits: Partial<SniLimits>) {
  const sockets: TLSSocket[] = [];
  const handler = machineCallsHttp(
    () => ({ handle: async () => ({ status: 200, body: { ok: true } }) }),
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
    requests: (request, response) => {
      const socket = request.socket as TLSSocket;
      if (!sockets.includes(socket)) sockets.push(socket);
      handler(request, response);
    },
    delay: systemDeliveryRuntime.delay,
    log: () => {},
    limits,
  });
  const port = await listener.listen("127.0.0.1", 0);
  cleanups.push(() => listener.close());
  return { sockets, origin: `https://127.0.0.1:${port}/` };
}

/** One request on a connection of its own that the caller keeps open as long as it is allowed. */
function rawCall(address: string, bearer: string) {
  return new Promise<{ status: number; keepAlive: string | undefined }>((resolve, reject) => {
    const agent = pinnedKeepAliveAgent(identity.fingerprint, { get: () => undefined, set() {} }, 1);
    cleanups.push(() => agent.destroy());
    const request = httpsRequest(
      new URL("/v1/machine-calls", address),
      { method: "POST", agent, headers: { authorization: `Bearer ${bearer}` } },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            keepAlive:
              typeof response.headers["keep-alive"] === "string"
                ? response.headers["keep-alive"]
                : undefined,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ origin, call: { op: "describe" } }));
  });
}

test("a connection that never authenticated keeps the short keep-alive, and says so", async () => {
  const target = await limitedMachine({});
  const answer = await rawCall(target.origin, "f".repeat(64));
  expect(answer).toEqual({ status: 401, keepAlive: "timeout=5" });
});

test("a connection whose call authenticated is kept open longer, and says so", async () => {
  const target = await limitedMachine({ keepAlive: 300, trustedKeepAlive: 60_000 });
  const answer = await rawCall(target.origin, token("a"));
  expect(answer.keepAlive).toBe("timeout=60");
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(target.sockets[0]?.destroyed).toBe(false);
});

test("an unauthenticated connection is closed after the short limit", async () => {
  const target = await limitedMachine({ keepAlive: 300, trustedKeepAlive: 60_000 });
  await rawCall(target.origin, "f".repeat(64));
  await expect.poll(() => target.sockets[0]?.destroyed, { timeout: 1500 }).toBe(true);
});

test("a status answer full of agent results goes uncompressed, even to a caller that offers zstd", async () => {
  const results = {
    threads: Array.from({ length: 16 }, (_, index) => ({
      threadId: `child-${index}`,
      state: "done",
      title: "Review the open pull requests",
      elapsedSeconds: 30,
      status: { state: "done" },
      requests: [],
      result: `Signed in at https://example.test/callback?code=${index} and reviewed the diff.`,
      truncated: false,
    })),
  };
  const handler = machineCallsHttp(
    () => ({ handle: async () => ({ status: 200, body: results }) }),
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
  const agent = pinnedKeepAliveAgent(identity.fingerprint, { get: () => undefined, set() {} }, 1);
  cleanups.push(() => agent.destroy());
  const coding = await new Promise<string | undefined>((resolve, reject) => {
    const request = httpsRequest(
      new URL("/v1/machine-calls", `https://127.0.0.1:${port}/`),
      {
        method: "POST",
        agent,
        headers: { authorization: `Bearer ${token("a")}`, "accept-encoding": "zstd, deflate" },
      },
      (response) => {
        response.resume();
        const value = response.headers["content-encoding"];
        response.on("end", () => resolve(typeof value === "string" ? value : undefined));
      },
    );
    request.on("error", reject);
    request.end(
      JSON.stringify({ origin, call: { op: "status", threadIds: [ThreadId.parse("child-0")] } }),
    );
  });
  expect(coding).toBeUndefined();
});

test("a read sent again on a fresh connection keeps the call's own deadline", async () => {
  // Reads are slow there; the dropped connection takes 800 ms of a 1 s call to reset.
  const target = await busyMachine(1500, (asked) => asked.op === "status");
  const proxy = await cuttingProxy(Number(new URL(target.profile.origin).port), 800);
  const profile = { ...target.profile, origin: proxy.origin };
  const connections = pool();
  await machineRequest(
    profile,
    { origin, call: { op: "describe" } },
    { timeoutMs: 5000, connections },
  );
  proxy.cutAll();
  const started = Date.now();
  const failure = await machineRequest(
    profile,
    { origin, call: { op: "status", threadIds: [ThreadId.parse("child-1")] } },
    { timeoutMs: 1000, connections },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MachineFailure);
  // Never much past the caller's own 1 s, however the time was spent.
  expect(Date.now() - started).toBeLessThan(1300);
});

/** A pool whose timers the test can count, to show nothing is left running. */
function countedPool() {
  const live = new Set<object>();
  const connections = new MachineConnections({
    schedule: (ms, run) => {
      const handle = {};
      live.add(handle);
      const timer = setTimeout(() => {
        live.delete(handle);
        run();
      }, ms);
      return () => {
        live.delete(handle);
        clearTimeout(timer);
      };
    },
  });
  cleanups.push(() => connections.close());
  return { connections, live };
}

const followUp: MachineCall = {
  op: "message",
  threadId: ThreadId.parse("child-1"),
  requestId: "follow-up",
  text: "Run the tests again",
  delivery: "queue",
};

for (const [ending, end] of [
  ["unpaired", (connections: MachineConnections) => connections.retain([])],
  ["shut down", (connections: MachineConnections) => connections.close()],
] as const)
  test(`a call queued for a machine ${ending} never reaches it, and nothing is left open`, async () => {
    const target = await busyMachine(1500);
    const { connections, live } = countedPool();
    const long = Array.from({ length: 6 }, () =>
      machineRequest(
        target.profile,
        { origin, call: browserCall },
        { timeoutMs: 10_000, connections },
      ).catch((error: unknown) => error),
    );
    await expect.poll(() => target.arrived.length).toBe(6);
    const queued = machineRequest(
      target.profile,
      { origin, call: followUp },
      { timeoutMs: 10_000, connections },
    ).catch((error: unknown) => error);
    end(connections);
    // The queued message fails at once as never sent; the calls in flight fail as lost.
    const started = Date.now();
    expect(await queued).toBeInstanceOf(MachineNotSent);
    expect(Date.now() - started).toBeLessThan(500);
    for (const failure of await Promise.all(long)) {
      expect(failure).toBeInstanceOf(MachineFailure);
      expect((failure as MachineFailure).kind).toBe("disconnected");
    }
    // Long after the calls would have finished, the message still never arrived.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(target.arrived.map((entry) => entry.op)).not.toContain("message");
    expect([...target.sockets].every((socket) => socket.destroyed)).toBe(true);
    expect(live.size).toBe(0);
    // Nothing can be sent through the ended pool's pairing again without a new pool entry.
    if (ending === "shut down") {
      const after = await machineRequest(
        target.profile,
        { origin, call: followUp },
        { timeoutMs: 2000, connections },
      ).catch((error: unknown) => error);
      expect(after).toBeInstanceOf(MachineNotSent);
    }
  });

test("a read whose answer had begun to arrive is never sent again", async () => {
  const served = new Map<object, number>();
  let reads = 0;
  const listener = sniListener({
    tls: identity,
    requests: (request, response) => {
      reads++;
      const socket = request.socket;
      const count = (served.get(socket) ?? 0) + 1;
      served.set(socket, count);
      request.resume();
      request.on("end", () => {
        if (count === 1) {
          response.writeHead(200, { "content-type": "application/json" }).end("{}");
          return;
        }
        // The second read on this connection gets part of a status line, then the connection
        // is dropped: the machine had started answering it.
        socket.write("HTTP/1.1 20");
        setTimeout(() => socket.destroy(), 50);
      });
    },
    delay: systemDeliveryRuntime.delay,
    log: () => {},
  });
  const port = await listener.listen("127.0.0.1", 0);
  cleanups.push(() => listener.close());
  const profile = {
    origin: `https://127.0.0.1:${port}/`,
    fingerprint: identity.fingerprint,
    token: token("a"),
  };
  const connections = pool();
  const read = { origin, call: { op: "status" as const, threadIds: [ThreadId.parse("child-1")] } };
  await machineRequest({ ...target(profile) }, read, { timeoutMs: 5000, connections });
  const failure = await machineRequest({ ...target(profile) }, read, {
    timeoutMs: 5000,
    connections,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MachineFailure);
  expect(reads).toBe(2);
});

/** A full saved profile for an address, pin and token. */
function target(profile: { origin: string; fingerprint: string; token: string }) {
  return {
    id: "5b0f3f4e-8f3a-4b8e-9d3c-2f6a1c7e9b10",
    name: "studio",
    deviceId: DeviceId.parse("device-1"),
    ...profile,
  };
}
