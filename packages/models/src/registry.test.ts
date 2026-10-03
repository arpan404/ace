import { expect, test } from "vitest";
import { createModelDiscovery, ModelCatalog, ModelInstance } from "./index.ts";
import type { CacheEntry } from "./types.ts";
const metadata = (value: string) => ({
  configOptions: [
    {
      id: "actual-model-selector",
      category: "model",
      type: "select",
      currentValue: value,
      options: [{ value, name: value }],
    },
  ],
});
const instance = (
  id: string,
  agent = "local:one",
  installation = "installed-one",
  loginRevision = "login-one",
) =>
  ModelInstance.parse({
    id,
    provider: "acp",
    acpAgentId: agent,
    installationId: installation,
    instanceId: `${id}-home`,
    profileRevision: "source-one",
    loginRevision,
    executable: "/never-executed",
    cwd: "/repo",
  });
test("generic model listing and explicit refresh never launch a metadata session or a process", async () => {
  const config = instance("one");
  const rows = await createModelDiscovery({
    spawn() {
      throw new Error("Generic discovery must not execute");
    },
  })(config, new AbortController().signal);
  expect(rows).toEqual([]);
  const catalog = new ModelCatalog({
    instances: [config],
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    discover: async () => {
      throw new Error("No metadata-only ACP sessions");
    },
    now: () => 1,
    deadline() {
      throw new Error("No deadline required");
    },
  });
  try {
    expect(catalog.list().models).toEqual([]);
    await catalog.refresh();
    expect(catalog.list().instances[0]?.stale).toBe(true);
  } finally {
    await catalog.close();
  }
});
test("two ACP agents and account homes retain separate native IDs and login generations", async () => {
  const entries = new Map<string, CacheEntry>();
  const one = instance("one");
  const two = instance("two", "local:two", "installed-two");
  const catalog = new ModelCatalog({
    instances: [one, two],
    storage: {
      load: () => [...entries.values()],
      replace(entry) {
        entries.set(entry.instance, entry);
      },
      remove(id) {
        entries.delete(id);
      },
      close() {},
    },
    discover: async () => {
      throw new Error("No discovery");
    },
    now: () => 10,
    deadline: () => () => {},
  });
  try {
    await catalog.updateFromSession(one, metadata("same-native"));
    await catalog.updateFromSession(two, metadata("same-native"));
    const rows = catalog.list().models;
    expect(rows.map((row) => [row.id, row.acpAgentId, row.instanceId, row.modelConfigId])).toEqual([
      ["same-native", "local:one", "one-home", "actual-model-selector"],
      ["same-native", "local:two", "two-home", "actual-model-selector"],
    ]);
    await catalog.loginChanged("one", "new-login");
    expect(catalog.list({ instance: "one" }).models).toEqual([]);
    expect(catalog.list({ instance: "two" }).models).toHaveLength(1);
    await expect(catalog.updateFromSession(one, metadata("old-generation"))).rejects.toThrow(
      "generation",
    );
    catalog.registerInstance({ ...two, installationId: "updated-two" });
    expect(catalog.list({ instance: "two" }).models).toEqual([]);
  } finally {
    await catalog.close();
  }
});

test("dependent session updates serialize persistence and shutdown waits for the last stored choice", async () => {
  const config = instance("one");
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let stored: CacheEntry | undefined;
  let storageClosed = false;
  const catalog = new ModelCatalog({
    instances: [config],
    storage: {
      load: () => [],
      async replace(entry) {
        if (entry.models[0]?.id === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        if (storageClosed) throw new Error("Storage closed before persistence");
        stored = entry;
      },
      remove() {
        stored = undefined;
      },
      close() {
        storageClosed = true;
      },
    },
    discover: async () => [],
    now: () => 10,
    deadline: () => () => {},
  });
  try {
    const first = catalog.updateFromSession(config, metadata("first"));
    await firstStarted.promise;
    const last = catalog.updateFromSession(config, metadata("last"));
    releaseFirst.resolve();
    await Promise.all([first, last]);
    expect(stored?.models[0]?.id).toBe("last");
    expect(catalog.list().models[0]?.id).toBe("last");
  } finally {
    releaseFirst.resolve();
    await catalog.close();
  }
});

test("shutdown leaves storage open until an admitted session write finishes", async () => {
  const config = instance("one");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stored: CacheEntry | undefined;
  let closed = false;
  const catalog = new ModelCatalog({
    instances: [config],
    storage: {
      load: () => [],
      async replace(entry) {
        started.resolve();
        await release.promise;
        if (closed) throw new Error("Closed storage");
        stored = entry;
      },
      remove() {},
      close() {
        closed = true;
      },
    },
    discover: async () => [],
    now: () => 10,
    deadline: () => () => {},
  });
  const write = catalog.updateFromSession(config, metadata("persisted"));
  await started.promise;
  const closing = catalog.close();
  release.resolve();
  await write;
  await closing;
  expect(stored?.models[0]?.id).toBe("persisted");
  expect(closed).toBe(true);
});

test("generic catalogs do not offer unprofiled legacy setters or infer capacity from option names", async () => {
  const config = instance("one");
  const catalog = new ModelCatalog({
    instances: [config],
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    discover: async () => [],
    now: () => 10,
    deadline: () => () => {},
  });
  try {
    await catalog.updateFromSession(config, {
      models: {
        currentModelId: "legacy",
        availableModels: [{ modelId: "legacy", name: "Legacy" }],
      },
    });
    expect(catalog.list().models).toEqual([]);
    await catalog.updateFromSession(config, {
      configOptions: [
        ...metadata("native").configOptions,
        {
          id: "context",
          type: "select",
          currentValue: "100k",
          options: [{ value: "100k", name: "Opaque context" }],
        },
      ],
    });
    expect(catalog.list().models[0]?.id).toBe("native");
    expect(catalog.list().models[0]?.contextWindow).toBeUndefined();
  } finally {
    await catalog.close();
  }
});
