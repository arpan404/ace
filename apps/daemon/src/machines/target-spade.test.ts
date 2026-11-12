import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Device, type MachineAgentAccess, type MachineGrantLevel } from "@ace/protocol";
import { Store } from "../store.ts";
import type { SpadeConnection } from "../spade/forward.ts";
import { MachineGrantStore } from "./grant-store.ts";
import { GuestSessions } from "./guest-sessions.ts";
import { TargetBrowser } from "./target-browser.ts";
import { TargetThreads } from "./target-threads.ts";
import { createMachineTarget } from "./target.ts";
import { inboxProof } from "./target-spade.ts";

const inboxKey = "k".repeat(64);

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
  raw: Buffer;
}

/** A local HTTP server standing in for this machine's Spade, answering every inbox request. */
async function fakeSpade(answer: { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        raw: Buffer.concat(chunks),
      });
      response.setHeader("content-type", "application/json");
      response.statusCode = answer.status;
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const connection: SpadeConnection = {
    host: "127.0.0.1",
    port: address.port,
    token: "t".repeat(43),
  };
  return { connection, seen };
}

const device = Device.parse({
  id: "laptop-device",
  name: "Laptop",
  scopes: ["read", "operate"],
  createdAt: 0,
  lastSeenAt: 0,
  revokedAt: null,
});
const origin = {
  hostId: "laptop-host",
  hostName: "Laptop",
  threadId: "spade-host-thread",
  threadTitle: "Spade",
  ceiling: "operate",
};

/** This machine's target, with its switch and the laptop's Agents grant as given. */
function machine(input: {
  access: MachineAgentAccess;
  agents?: MachineGrantLevel;
  spade: SpadeConnection | undefined;
  from?: Device;
}) {
  const dir = mkdtempSync(join(tmpdir(), "ace-target-spade-"));
  const store = new Store(join(dir, "events.sqlite"));
  cleanup.push(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const threads = new TargetThreads({
    store,
    engine: () => undefined,
    journal: () => undefined,
    now: () => 0,
    limit: () => undefined,
    schedule: () => () => {},
    report: () => {},
  });
  cleanup.push(() => threads.close());
  const guests = new GuestSessions({
    store,
    engine: () => undefined,
    threads,
    chat: () => Promise.reject(new Error("No chats here")),
    newId: () => "id",
    remove: () => Promise.resolve(),
  });
  const grants = new MachineGrantStore(store, () => 0);
  if (input.agents) grants.set(device.id, "agents", input.agents);
  const target = createMachineTarget({
    hostId: "desk-host",
    hostName: async () => "Desk",
    access: async () => input.access,
    engine: () => undefined,
    threads,
    browser: new TargetBrowser({ store, browser: () => undefined, guests }),
    guests,
    grants,
    hosts: {},
    commandJobs: () => ({ jobs: [] }),
    spade: () => input.spade,
    inboxKey: () => inboxKey,
    now: () => 1_000,
    log: () => {},
  });
  return (request: Record<string, unknown>, from: Record<string, unknown> = origin) =>
    target.handle(
      input.from ?? device,
      { origin: from, call: { op: "spade", request } },
      new AbortController().signal,
    );
}

test("a spade call reaches this machine's Spade inbox stamped with the calling machine", async () => {
  const spade = await fakeSpade({ status: 202, body: { status: "accepted" } });
  const call = machine({ access: "operate", spade: spade.connection });
  const ask = { op: "ask", key: "laptop-host.a1", to: "bot-1", text: "Hello", depth: 1 };
  expect(await call(ask)).toEqual({
    status: 200,
    body: { status: 202, body: { status: "accepted" } },
  });
  expect(spade.seen).toHaveLength(1);
  const [seen] = spade.seen;
  expect(seen).toMatchObject({ method: "POST", url: "/v1/inbox", body: ask });
  expect(seen?.headers).toMatchObject({
    authorization: `Bearer ${"t".repeat(43)}`,
    // The pairing that authenticated the call, not the host id it claims.
    "x-ace-from-host": "laptop-device",
    "x-ace-from-name": "Laptop",
    "x-ace-inbox-time": "1000",
  });
  expect(seen?.headers["x-ace-inbox-proof"]).toBe(
    inboxProof(inboxKey, 1_000, "laptop-device", "Laptop", seen?.raw ?? Buffer.alloc(0)),
  );
});

test("a name outside ASCII is sent percent-encoded and signed as sent", async () => {
  const spade = await fakeSpade({ status: 200, body: { bots: [] } });
  const call = machine({ access: "operate", spade: spade.connection });
  await call({ op: "bots" }, { ...origin, hostName: "Arpan\u2019s Mac" });
  const [seen] = spade.seen;
  expect(seen?.headers["x-ace-from-name"]).toBe("Arpan%E2%80%99s%20Mac");
});

test("the signature matches the one Spade checks", () => {
  // The same vector is checked in spade-server's `inbox_proof` test.
  expect(
    inboxProof("k".repeat(64), 1_000, "laptop-device", "Laptop", Buffer.from('{"op":"bots"}')),
  ).toBe("9326fdb7539c287a4116cc8be088e4e560fa39f64ddd273f9c3d8dac96818a75");
});

test("a pairing from a time-limited link can't reach Spade", async () => {
  const spade = await fakeSpade({ status: 200, body: { bots: [] } });
  const guest = Device.parse({ ...device, id: "guest", expiresAt: 5_000 });
  const call = machine({ access: "operate", spade: spade.connection, from: guest });
  expect(await call({ op: "bots" })).toMatchObject({ status: 403 });
  expect(spade.seen).toHaveLength(0);
});

test("Spade's error answers there come back with their status, not as refusals", async () => {
  const spade = await fakeSpade({ status: 404, body: { error: "no such bot" } });
  const call = machine({ access: "operate", spade: spade.connection });
  expect(await call({ op: "ask", key: "k", to: "gone", text: "Hi", depth: 1 })).toEqual({
    status: 200,
    body: { status: 404, body: { error: "no such bot" } },
  });
});

test("a read-only Agents grant lets the other machine list bots and read answers, not ask or stop", async () => {
  const spade = await fakeSpade({ status: 200, body: { bots: [] } });
  const call = machine({ access: "operate", agents: "read", spade: spade.connection });
  expect(await call({ op: "bots" })).toMatchObject({ status: 200 });
  expect(await call({ op: "answer", key: "k", wait_ms: 0 })).toMatchObject({ status: 200 });
  for (const request of [
    { op: "ask", key: "k", to: "b", text: "Hi", depth: 1 },
    { op: "stop", key: "k" },
    { op: "something-newer" },
  ])
    expect(await call(request)).toMatchObject({
      status: 403,
      body: { error: "machine_forbidden" },
    });
  // Only the two reads reached Spade.
  expect(spade.seen.map((seen) => (seen.body as { op: string }).op)).toEqual(["bots", "answer"]);
});

test("with Agents off for that machine, nothing reaches Spade", async () => {
  const spade = await fakeSpade({ status: 200, body: { bots: [] } });
  const call = machine({ access: "operate", agents: "off", spade: spade.connection });
  expect(await call({ op: "bots" })).toMatchObject({ status: 403 });
  expect(spade.seen).toHaveLength(0);
});

test("with Spade off on this machine, the call is refused as unavailable", async () => {
  const call = machine({ access: "operate", spade: undefined });
  expect(await call({ op: "bots" })).toEqual({
    status: 503,
    body: { error: "unavailable", message: "Spade isn't running on this machine." },
  });
});
