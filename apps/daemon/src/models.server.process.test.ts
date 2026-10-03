import { afterEach, expect, test } from "vitest";
import {
  ModelCatalog,
  openModelStorage,
  normalizeCodex,
  ModelInstance,
  type CatalogModel,
} from "@ace/models";
import { setup as remoteSetup } from "./remote-test-support.ts";
import { fixture } from "./socket-test-support.ts";
function noRelease(): never {
  throw new Error("Provider not started");
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
function model() {
  const instance = ModelInstance.parse({
    id: "account",
    provider: "codex",
    loginRevision: "1",
    executable: "codex",
    cwd: "/repo",
  });
  const rows = normalizeCodex(
    {
      data: [
        {
          id: "catalog",
          model: "coder",
          displayName: "Coder",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          defaultReasoningEffort: "high",
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
      ],
    },
    instance,
  );
  return { instance, rows };
}
async function setup() {
  const { instance, rows } = model();
  const catalog = new ModelCatalog({
    storage: openModelStorage(":memory:"),
    instances: [instance],
    discover: async () => rows,
    now: () => 1000,
    deadline(expire, ms) {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
  });
  cleanups.push(() => catalog.close());
  await catalog.refresh();
  const f = await fixture({ models: catalog });
  cleanups.push(f.close);
  return { f, catalog };
}
test("authenticated clients list, refresh and resolve models through correlated wire requests", async () => {
  const { f } = await setup();
  const client = await f.connect();
  await client.next();
  const head = f.store.headSeq();
  client.send({
    type: "models.list",
    requestId: "list",
    options: { offset: 0, limit: 100, instance: "account" },
  });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "list",
    result: { models: [{ id: "coder", instance: "account" }] },
  });
  client.send({
    type: "models.resolve",
    requestId: "role",
    roleSpec: {
      role: "coder",
      selection: "default",
      preferenceOrder: [],
      imageInput: false,
      tier: "fast",
    },
  });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "role",
    result: { ok: true, model: { id: "coder" }, tier: { id: "priority" }, effort: "high" },
  });
  client.send({ type: "models.refresh", requestId: "refresh", filter: { instance: "account" } });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "refresh",
    result: { instances: [{ stale: false, refreshing: false }] },
  });
  expect(f.store.headSeq()).toBe(head);
});
test("catalog requests before hello cannot reveal provider models", async () => {
  const { f } = await setup();
  const client = await f.open();
  client.send({ type: "models.list", requestId: "private", options: { offset: 0, limit: 100 } });
  expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
});
test("malformed catalog filters fail at the socket boundary", async () => {
  const { f } = await setup();
  const client = await f.connect();
  await client.next();
  client.socket.send(
    JSON.stringify({
      type: "models.list",
      requestId: "bad",
      options: { provider: "unknown", limit: 999 },
    }),
  );
  expect(await client.next()).toMatchObject({ type: "error", code: "invalid_message" });
});
test("slow refreshes leave ping and cached model queries responsive", async () => {
  let release: (rows: CatalogModel[]) => void = noRelease;
  const rows = model().rows;
  let calls = 0;
  const slow = new ModelCatalog({
    storage: openModelStorage(":memory:"),
    instances: [model().instance],
    discover: () =>
      ++calls === 1
        ? Promise.resolve(rows)
        : new Promise((resolve) => {
            release = resolve;
          }),
    now: () => 1000,
    deadline(expire, ms) {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
  });
  cleanups.push(() => slow.close());
  await slow.refresh();
  const f = await fixture({ models: slow });
  cleanups.push(f.close);
  const connected = await f.connect();
  await connected.next();
  connected.send({ type: "models.refresh", requestId: "slow", filter: {} });
  connected.send({ type: "ping" });
  expect(await connected.next()).toEqual({ type: "pong" });
  connected.send({ type: "models.list", requestId: "cached", options: { offset: 0, limit: 100 } });
  expect(await connected.next()).toMatchObject({
    type: "models.result",
    requestId: "cached",
    result: { models: [{ id: "coder" }], instances: [{ refreshing: true }] },
  });
  connected.send({
    type: "models.resolve",
    requestId: "cached-role",
    roleSpec: { role: "coder", selection: "default", preferenceOrder: [], imageInput: false },
  });
  expect(await connected.next()).toMatchObject({
    type: "models.result",
    requestId: "cached-role",
    result: { ok: true, model: { id: "coder" } },
  });
  release(rows);
  expect(await connected.next()).toMatchObject({
    type: "models.result",
    requestId: "slow",
    result: { models: [{ id: "coder" }] },
  });
});

test("maximum-length legal policies return valid correlated socket replies", async () => {
  const { instance } = model();
  const id = "m".repeat(256);
  const tier = "t".repeat(256);
  const effort = "e".repeat(256);
  const rows = normalizeCodex(
    {
      data: [
        {
          id: "catalog",
          model: id,
          displayName: "Long model",
          isDefault: true,
          defaultReasoningEffort: effort,
          supportedReasoningEfforts: [{ reasoningEffort: effort }],
          serviceTiers: [{ id: tier, name: "Long tier" }],
        },
      ],
    },
    instance,
  );
  const catalog = new ModelCatalog({
    storage: openModelStorage(":memory:"),
    instances: [instance],
    discover: async () => rows,
    now: () => 1000,
    deadline: () => () => {},
  });
  cleanups.push(() => catalog.close());
  await catalog.refresh();
  const f = await fixture({ models: catalog });
  cleanups.push(f.close);
  const client = await f.connect();
  await client.next();
  client.send({
    type: "models.resolve",
    requestId: "long",
    roleSpec: {
      role: "r".repeat(256),
      model: id,
      tier,
      effort,
      selection: "default",
      preferenceOrder: [],
      imageInput: false,
    },
  });
  // The real client parses every received frame with ServerMessage.
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "long",
    result: { ok: true, model: { id }, tier: { id: tier }, effort },
  });
});

test("an unavailable catalog returns a correlated failure without breaking the socket", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const client = await f.connect();
  await client.next();
  client.send({ type: "models.list", requestId: "missing", options: { offset: 0, limit: 100 } });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "missing",
    result: { ok: false },
  });
  client.send({ type: "ping" });
  expect(await client.next()).toEqual({ type: "pong" });
});

test("paired read devices can inspect model choices but cannot launch explicit refreshes", async () => {
  const { catalog } = await setup();
  const f = await remoteSetup({ models: catalog });
  const paired = await f.pair(["read"]);
  const ticket = await f.ticket(paired.token);
  const client = await f.connectTicket(paired.device.id, ticket.ticket);
  await client.next();
  client.send({ type: "models.list", requestId: "read", options: { offset: 0, limit: 100 } });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "read",
    result: { models: [{ id: "coder" }] },
  });
  client.send({ type: "models.refresh", requestId: "denied", filter: {} });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "denied",
    result: { ok: false, reason: "operate scope required" },
  });
});

test("paired devices need read scope to list or resolve model choices", async () => {
  const { catalog } = await setup();
  const f = await remoteSetup({ models: catalog });
  const paired = await f.pair(["operate"]);
  const ticket = await f.ticket(paired.token);
  const client = await f.connectTicket(paired.device.id, ticket.ticket);
  await client.next();
  client.send({
    type: "models.list",
    requestId: "list-denied",
    options: { offset: 0, limit: 100 },
  });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "list-denied",
    result: { ok: false, reason: "read scope required" },
  });
  client.send({
    type: "models.resolve",
    requestId: "resolve-denied",
    roleSpec: { role: "coder", selection: "default", imageInput: false, preferenceOrder: [] },
  });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "resolve-denied",
    result: { ok: false, reason: "read scope required" },
  });
});
