import type { ServerMessage } from "@ace/protocol";
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
async function nextReply(client: { next(): Promise<ServerMessage> }): Promise<ServerMessage> {
  for (let i = 0; i < 8; i++) {
    const message = await client.next();
    if (message.type !== "models.changed") return message;
  }
  throw new Error("Catalog updates never yielded a reply");
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
  await nextReply(client);
  const head = f.store.headSeq();
  client.send({
    type: "models.list",
    requestId: "list",
    options: { offset: 0, limit: 100, instance: "account" },
  });
  expect(await nextReply(client)).toMatchObject({
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
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    requestId: "role",
    result: { ok: true, model: { id: "coder" }, tier: { id: "priority" }, effort: "high" },
  });
  client.send({ type: "models.refresh", requestId: "refresh", filter: { instance: "account" } });
  expect(await nextReply(client)).toMatchObject({
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
  expect(await nextReply(client)).toMatchObject({ type: "error", code: "unauthorized" });
});
test("malformed catalog filters fail at the socket boundary", async () => {
  const { f } = await setup();
  const client = await f.connect();
  await nextReply(client);
  client.socket.send(
    JSON.stringify({
      type: "models.list",
      requestId: "bad",
      options: { provider: "unknown", limit: 999 },
    }),
  );
  expect(await nextReply(client)).toMatchObject({ type: "error", code: "invalid_message" });
});
test("slow refreshes leave ping and cached model queries responsive", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<CatalogModel[]>();
  const rows = model().rows;
  let calls = 0;
  const slow = new ModelCatalog({
    storage: openModelStorage(":memory:"),
    instances: [model().instance],
    discover: () => {
      if (++calls === 1) return Promise.resolve(rows);
      started.resolve();
      return release.promise;
    },
    now: () => 1000,
    deadline: () => () => {},
  });
  cleanups.push(() => slow.close());
  await slow.refresh();
  const f = await fixture({ models: slow });
  cleanups.push(async () => {
    release.resolve(rows);
    await f.close();
  });
  const connected = await f.connect();
  await nextReply(connected);
  connected.send({ type: "models.refresh", requestId: "slow", filter: {} });
  await started.promise;
  connected.send({ type: "ping" });
  expect(await nextReply(connected)).toEqual({ type: "pong" });
  connected.send({ type: "models.list", requestId: "cached", options: { offset: 0, limit: 100 } });
  expect(await nextReply(connected)).toMatchObject({
    type: "models.result",
    requestId: "cached",
    result: { models: [{ id: "coder" }], instances: [{ refreshing: true }] },
  });
  connected.send({
    type: "models.resolve",
    requestId: "cached-role",
    roleSpec: { role: "coder", selection: "default", preferenceOrder: [], imageInput: false },
  });
  expect(await nextReply(connected)).toMatchObject({
    type: "models.result",
    requestId: "cached-role",
    result: { ok: true, model: { id: "coder" } },
  });
  release.resolve(rows);
  expect(await nextReply(connected)).toMatchObject({
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
  await nextReply(client);
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
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    requestId: "long",
    result: { ok: true, model: { id }, tier: { id: tier }, effort },
  });
});

test("an unavailable catalog returns a correlated failure without breaking the socket", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const client = await f.connect();
  await nextReply(client);
  client.send({ type: "models.list", requestId: "missing", options: { offset: 0, limit: 100 } });
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    requestId: "missing",
    result: { ok: false },
  });
  client.send({ type: "ping" });
  expect(await nextReply(client)).toEqual({ type: "pong" });
});

test("paired read devices can inspect model choices but cannot launch explicit refreshes", async () => {
  const { catalog } = await setup();
  const f = await remoteSetup({ models: catalog });
  const paired = await f.pair(["read"]);
  const ticket = await f.ticket(paired.token);
  const client = await f.connectTicket(paired.device.id, ticket.ticket);
  await nextReply(client);
  client.send({ type: "models.list", requestId: "read", options: { offset: 0, limit: 100 } });
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    requestId: "read",
    result: { models: [{ id: "coder" }] },
  });
  client.send({ type: "models.refresh", requestId: "denied", filter: {} });
  expect(await nextReply(client)).toMatchObject({
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
  await nextReply(client);
  client.send({
    type: "models.list",
    requestId: "list-denied",
    options: { offset: 0, limit: 100 },
  });
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    requestId: "list-denied",
    result: { ok: false, reason: "read scope required" },
  });
  client.send({
    type: "models.resolve",
    requestId: "resolve-denied",
    roleSpec: { role: "coder", selection: "default", imageInput: false, preferenceOrder: [] },
  });
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    requestId: "resolve-denied",
    result: { ok: false, reason: "read scope required" },
  });
});

test("background catalog changes reach every authenticated read client and their next read returns the replacement", async () => {
  const { f, catalog } = await setup();
  const first = await f.connect();
  const second = await f.connect();
  first.receiveCatalogPushes = second.receiveCatalogPushes = true;
  await first.next();
  await second.next();
  await catalog.invalidate({ instance: "account" });
  expect(await first.next()).toEqual({
    type: "models.changed",
    filter: { provider: "codex", instance: "account" },
  });
  expect(await second.next()).toEqual({
    type: "models.changed",
    filter: { provider: "codex", instance: "account" },
  });
  const flight = catalog.refresh();
  expect(await first.next()).toMatchObject({ type: "models.changed" });
  expect(await second.next()).toMatchObject({ type: "models.changed" });
  await flight;
  expect(await first.next()).toMatchObject({ type: "models.changed" });
  expect(await second.next()).toMatchObject({ type: "models.changed" });
  first.send({
    type: "models.list",
    requestId: "updated",
    options: { instance: "account", offset: 0, limit: 100 },
  });
  expect(await first.next()).toMatchObject({
    type: "models.result",
    result: {
      models: [
        {
          displayName: "Coder",
          source: { kind: "account", id: "account" },
          tier: "current",
          isDefault: true,
        },
      ],
      instances: [
        {
          status: "fresh",
          lastRefreshedAt: 1000,
          sources: [{ source: { id: "account" }, status: "fresh" }],
        },
      ],
    },
  });
});

test("legacy Cursor catalog requests list and resolve the sole SDK instance", async () => {
  const { f, catalog } = await setup();
  catalog.registerInstance({
    id: "cursor-sdk-default",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: f.home,
    cwd: f.home,
    loginRevision: "sdk",
  });
  await catalog.updateFromSession(
    {
      id: "cursor-sdk-default",
      provider: "cursor",
      backend: "cursor-sdk",
      homeDir: f.home,
      cwd: f.home,
      loginRevision: "sdk",
    },
    {
      models: {
        currentModelId: "composer-2.5",
        availableModels: [{ modelId: "composer-2.5", name: "Composer" }],
      },
    },
  );
  const client = await f.connect();
  await nextReply(client);
  client.send({
    type: "models.list",
    requestId: "legacy-list",
    options: { provider: "cursor", instance: "cursor-cli-default", offset: 0, limit: 100 },
  });
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    result: {
      models: [
        { provider: "cursor", instance: "cursor-sdk-default", nativeModelId: "composer-2.5" },
      ],
      instances: [{ instance: "cursor-sdk-default" }],
    },
  });
  client.send({
    type: "models.resolve",
    requestId: "legacy-resolve",
    roleSpec: {
      role: "worker",
      provider: "cursor",
      instance: "cursor-cli-default",
      selection: "default",
      preferenceOrder: [],
      imageInput: false,
    },
  });
  expect(await nextReply(client)).toMatchObject({
    type: "models.result",
    result: { ok: true, model: { nativeModelId: "composer-2.5", instance: "cursor-sdk-default" } },
  });
});
