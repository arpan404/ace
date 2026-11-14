import type { TLSSocket } from "node:tls";
import { afterEach, expect, test } from "vitest";
import { systemDeliveryRuntime } from "../delivery-runtime.ts";
import { tlsFixtureHome } from "../process-test-support.ts";
import { sniListener, type SniLimits } from "../sni-listener.ts";
import { loadIdentity } from "../tls-identity.ts";
import { MachineConnections } from "./connections.ts";
import { MachineFailure, pinnedRequest } from "./transport.ts";

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
