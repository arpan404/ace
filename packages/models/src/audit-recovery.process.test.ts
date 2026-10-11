import { expect, test } from "vitest";
import { join } from "node:path";
import { ModelCatalog, openModelStorage, normalizeCodex } from "./index.ts";
import { Clock, instance, workspace, deferred, codexPayload } from "./testing/support.ts";

test("a failed discovery deletion clears its flight so a later refresh can recover", async () => {
  const work = await workspace();
  const clock = new Clock();
  const storage = openModelStorage(join(work.path, "models.sqlite"));
  let broken = true;
  const catalog = new ModelCatalog({
    storage: {
      ...storage,
      remove: (id) =>
        broken ? Promise.reject(new Error("Disk refused deletion")) : storage.remove(id),
    },
    instances: [instance()],
    now: () => clock.now,
    deadline: clock.deadline,
    discover: async () => {
      if (broken) throw Object.assign(new Error("Not configured"), { code: "not_configured" });
      return normalizeCodex(codexPayload(), instance());
    },
  });
  try {
    await catalog.refresh();
    expect(catalog.list().instances[0]).toMatchObject({
      refreshing: false,
      errorDetail: { code: "not_configured" },
    });
    broken = false;
    await catalog.refresh();
    expect(catalog.list().models[0]?.id).toBe("coder");
  } finally {
    await catalog.close();
    await work.close();
  }
});

test("a storage write failure keeps discovered models usable in memory", async () => {
  const work = await workspace();
  const clock = new Clock();
  const storage = openModelStorage(join(work.path, "models.sqlite"));
  const catalog = new ModelCatalog({
    storage: {
      ...storage,
      replace: async () => {
        throw new Error("Worker failed");
      },
    },
    instances: [instance()],
    now: () => clock.now,
    deadline: clock.deadline,
    discover: async () => normalizeCodex(codexPayload(), instance()),
  });
  try {
    await catalog.refresh();
    expect(catalog.resolve({ provider: "codex", role: "worker" })).toMatchObject({
      ok: true,
      model: { id: "coder" },
    });
    expect(catalog.list().instances[0]).toMatchObject({
      refreshing: false,
      error: "persistence_failed",
    });
  } finally {
    await catalog.close();
    await work.close();
  }
});

test("OpenCode connection polls share discovery backoff and a retry preserves the failure until success", async () => {
  const work = await workspace();
  const clock = new Clock();
  const storage = openModelStorage(join(work.path, "models.sqlite"));
  const first = deferred<void>();
  let connectionAvailable = false;
  const recovered = deferred<void>();
  const catalog = new ModelCatalog({
    storage,
    instances: [instance("opencode")],
    now: () => clock.now,
    deadline: clock.deadline,
    revisionProbe: async () => {
      if (!connectionAvailable) throw new Error("Connection poll failed");
      return "new-connection";
    },
    discover: async () => {
      if (!connectionAvailable) {
        first.resolve();
        return new Promise((_, reject) => {
          reject(Object.assign(new Error("timeout"), { code: "timeout" }));
        });
      }
      await recovered.promise;
      return normalizeCodex(codexPayload(), instance("opencode"));
    },
  });
  try {
    const failedRefresh = catalog.refresh();
    await first.promise;
    await failedRefresh;
    clock.now += 10_000;
    await catalog.reconcileConnections();
    expect(catalog.list().instances[0]).toMatchObject({
      refreshing: false,
      errorDetail: { code: "timeout" },
    });
    connectionAvailable = true;
    const refresh = catalog.refresh();
    expect(catalog.list().instances[0]).toMatchObject({
      refreshing: false,
      errorDetail: { code: "timeout" },
    });
    recovered.resolve();
    await refresh;
    expect(catalog.list().instances[0]?.errorDetail).toBeUndefined();
  } finally {
    recovered.resolve();
    await catalog.close();
    await work.close();
  }
});

test("catalog shutdown closes storage even after a failed session write", async () => {
  const work = await workspace();
  const storage = openModelStorage(join(work.path, "models.sqlite"));
  const closed = deferred<void>();
  const catalog = new ModelCatalog({
    storage: {
      ...storage,
      replace: async () => {
        throw new Error("Disk full");
      },
      close: async () => {
        await storage.close();
        closed.resolve();
      },
    },
    instances: [instance("acp")],
    now: () => 1000,
    deadline: () => () => {},
    discover: async () => [],
  });
  try {
    // The public session catalog write is fire-and-forget; shutdown must drain its rejection.
    const write = catalog.updateFromSession(instance("acp"), {
      models: {
        currentModelId: "example",
        availableModels: [{ modelId: "example", name: "Example" }],
      },
    });
    const closing = catalog.close();
    await expect(write).rejects.toThrow("Disk full");
    await expect(closing).rejects.toThrow("cleanup failed");
    await closed.promise;
  } finally {
    await work.close();
  }
});
