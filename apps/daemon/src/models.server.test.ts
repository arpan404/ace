import { afterEach, expect, test } from "vitest";
import {
  ModelCatalog,
  openModelStorage,
  normalizeCodex,
  ModelInstance,
  type CatalogModel,
} from "@ace/models";
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
  const { f, catalog } = await setup();
  const client = await f.connect();
  await client.next();
  let release: (rows: CatalogModel[]) => void = noRelease;
  const rows = model().rows;
  const slow = new ModelCatalog({
    storage: openModelStorage(":memory:"),
    instances: [model().instance],
    discover: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    now: () => 1000,
    deadline(expire, ms) {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
  });
  cleanups.push(() => slow.close());
  // Use a real server with a controllable provider edge, and synchronize on a ping.
  const other = await fixture({ models: slow });
  cleanups.push(other.close);
  const connected = await other.connect();
  await connected.next();
  connected.send({ type: "models.refresh", requestId: "slow", filter: {} });
  connected.send({ type: "ping" });
  expect(await connected.next()).toEqual({ type: "pong" });
  release(rows);
  expect(await connected.next()).toMatchObject({
    type: "models.result",
    requestId: "slow",
    result: { models: [{ id: "coder" }] },
  });
  expect(catalog.list().models[0]?.id).toBe("coder");
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
