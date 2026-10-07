import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import {
  ModelCatalog,
  openModelStorage,
  normalizeCodex,
  type CatalogModel,
  type DiscoverModels,
  type CatalogOptions,
} from "./index.ts";
import { Clock, codexPayload, deferred, instance, workspace } from "./testing/support.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup(
  discover: DiscoverModels,
  instances = [instance()],
  options: Pick<CatalogOptions, "onError"> = {},
) {
  const work = await workspace();
  cleanups.push(work.close);
  const clock = new Clock();
  const path = join(work.path, "cache.sqlite");
  const catalog = new ModelCatalog({
    ...options,
    storage: openModelStorage(path),
    discover,
    instances,
    now: () => clock.now,
    deadline: clock.deadline,
    ttlMs: 100,
    retryMs: 20,
  });
  cleanups.push(() => catalog.close());
  return { catalog, clock, path };
}
const models = (id = "coder") => normalizeCodex(codexPayload(id), instance());

test("cached pickers return immediately through TTL and revalidate stale rows once", async () => {
  const next = deferred<readonly CatalogModel[]>();
  const started = deferred<void>();
  let calls = 0;
  const { catalog, clock } = await setup(async () => {
    if (++calls === 1) return models();
    started.resolve();
    return next.promise;
  });
  await catalog.refresh();
  clock.now += 99;
  expect(catalog.list().instances[0]).toMatchObject({ stale: false, refreshing: false });
  expect(calls).toBe(1);
  clock.now++;
  const result = catalog.list();
  expect(result.models[0]?.id).toBe("coder");
  expect(result.instances[0]).toMatchObject({ stale: true, refreshing: true });
  await started.promise;
  const flight = catalog.refresh();
  catalog.list();
  next.resolve(models("new-coder"));
  await flight;
  expect(calls).toBe(2);
  expect(catalog.list().models[0]?.id).toBe("new-coder");
  expect(catalog.list().instances[0]?.stale).toBe(false);
});

test("persisted models are available before discovery after restart", async () => {
  const first = await setup(async () => models());
  await first.catalog.refresh();
  await first.catalog.close();
  const restarted = new ModelCatalog({
    storage: openModelStorage(first.path),
    discover: async () => {
      throw new Error("Offline");
    },
    instances: [instance()],
    now: () => first.clock.now,
    deadline: first.clock.deadline,
  });
  cleanups.push(() => restarted.close());
  expect(restarted.list().models[0]?.id).toBe("coder");
  expect(restarted.list().instances[0]?.refreshing).toBe(true);
});

test("concurrent explicit refreshes share one discovery result", async () => {
  const result = deferred<readonly CatalogModel[]>();
  let calls = 0;
  const { catalog } = await setup(async () => {
    calls++;
    return result.promise;
  });
  const first = catalog.refresh();
  const second = catalog.refresh();
  result.resolve(models());
  expect(await first).toEqual(await second);
  expect(calls).toBe(1);
  expect(catalog.list().models).toHaveLength(1);
});

test("failed refresh retains stale rows and cooldown prevents repeated probes", async () => {
  let calls = 0;
  const { catalog, clock } = await setup(async () => {
    if (++calls > 1) throw new Error("secret stderr");
    return models();
  });
  await catalog.refresh();
  clock.now += 100;
  const failed = await catalog.refresh();
  expect(JSON.stringify(failed)).not.toContain("secret stderr");
  expect(catalog.list()).toMatchObject({
    models: [{ id: "coder" }],
    instances: [{ error: "discovery_failed", stale: true, refreshing: false }],
  });
  catalog.list();
  expect(calls).toBe(2);
  clock.now += 20;
  await catalog.refresh();
  expect(calls).toBe(3);
  expect(JSON.stringify(catalog.list())).not.toContain("secret stderr");
});

test("unclassified diagnostics stay in bounded local logs while client and stored errors stay fixed", async () => {
  const config = {
    ...instance(),
    env: { CUSTOM_API_KEY: "private-env-value" },
  };
  const diagnostic: string[] = [];
  const payloads: string[] = [];
  let calls = 0;
  const { catalog, path } = await setup(
    async () => {
      if (++calls === 1) return models();
      throw new Error(
        "Metadata bootstrap failed: private-env-value Bearer private-token " + "x".repeat(300),
      );
    },
    [config],
    {
      onError: (_provider, _instance, error, _source, metadata) => {
        payloads.push(JSON.stringify(error));
        if (metadata?.reason) diagnostic.push(metadata.reason);
      },
    },
  );
  await catalog.refresh();
  catalog.listen(() => payloads.push(JSON.stringify(catalog.list())));
  payloads.push(JSON.stringify(await catalog.refresh()));
  payloads.push(JSON.stringify(catalog.list()));
  expect(catalog.list().instances[0]?.errorDetail?.message).toBe("Model discovery failed.");
  expect(diagnostic).toHaveLength(1);
  expect(diagnostic[0]).toContain("Metadata bootstrap failed");
  expect(diagnostic[0]?.length).toBeLessThanOrEqual(200);
  expect(diagnostic.join()).not.toMatch(/private-env-value|private-token/);
  expect(payloads.join()).not.toMatch(/Metadata bootstrap failed|private-env-value|private-token/);
  await catalog.close();
  const stored = openModelStorage(path);
  try {
    expect(JSON.stringify(stored.load())).not.toContain("Metadata bootstrap failed");
  } finally {
    await stored.close();
  }
});

test("classified failures never include provider prose in local diagnostic reasons", async () => {
  const reports: string[] = [];
  const { catalog } = await setup(
    async () => {
      throw Object.assign(new Error("private provider prose"), { status: 401 });
    },
    [instance()],
    { onError: (...report) => reports.push(JSON.stringify(report)) },
  );
  expect(await catalog.refresh()).toMatchObject([{ errorDetail: { code: "auth_expired" } }]);
  expect(reports).toHaveLength(1);
  expect(reports.join()).not.toMatch(/private provider prose|"reason"/);
});

test("source error text is removed before publishing and persisting a partial refresh", async () => {
  const source = models()[0]?.source;
  if (!source) throw new Error("Expected a source-qualified fixture");
  const { catalog, path } = await setup(async () =>
    Object.assign([], {
      sources: [
        {
          source,
          status: "stale" as const,
          error: {
            code: "discovery_failed" as const,
            message: "secret stderr",
            hint: "private provider hint",
          },
        },
      ],
    }),
  );
  const refresh = await catalog.refresh();
  expect(refresh[0]?.sources?.[0]?.error?.message).toBe("Model discovery failed.");
  expect(JSON.stringify([refresh, catalog.list()])).not.toMatch(
    /secret stderr|private provider hint/,
  );
  await catalog.close();
  const stored = openModelStorage(path);
  try {
    expect(JSON.stringify(stored.load())).not.toMatch(/secret stderr|private provider hint/);
  } finally {
    await stored.close();
  }
});

test("cached source errors from older versions never expose provider text after restart", async () => {
  const first = await setup(async () => models());
  await first.catalog.refresh();
  await first.catalog.close();
  const db = new DatabaseSync(first.path);
  try {
    const payload = db.prepare("SELECT payload FROM model_catalog").get()?.["payload"];
    if (typeof payload !== "string") throw new Error("Expected persisted catalog");
    const stored = z.record(z.string(), z.unknown()).parse(JSON.parse(payload));
    db.prepare("UPDATE model_catalog SET payload = ?").run(
      JSON.stringify({
        ...stored,
        sources: [
          {
            source: { kind: "account", id: "codex", label: "codex" },
            status: "stale",
            error: {
              code: "discovery_failed",
              message: "Model discovery failed: secret stderr",
              hint: "private provider hint",
            },
          },
        ],
      }),
    );
  } finally {
    db.close();
  }
  const pending = deferred<readonly CatalogModel[]>();
  const restarted = new ModelCatalog({
    storage: openModelStorage(first.path),
    discover: () => pending.promise,
    instances: [instance()],
    now: () => first.clock.now,
    deadline: first.clock.deadline,
  });
  cleanups.push(() => restarted.close());
  try {
    expect(restarted.list().models[0]?.id).toBe("coder");
    expect(restarted.list().instances[0]?.sources?.[0]?.error?.message).toBe(
      "Model discovery failed.",
    );
    expect(JSON.stringify(restarted.list())).not.toMatch(/secret stderr|private provider hint/);
  } finally {
    pending.resolve(models());
    await restarted.refresh();
  }
});

test("provider timeout leaves other instance models immediately available", async () => {
  const started = deferred<void>();
  const { catalog, clock } = await setup(
    async (config, signal) => {
      if (config.id === "hang") {
        started.resolve();
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      }
      return normalizeCodex(codexPayload(), config);
    },
    [instance("codex", "hang"), instance("codex", "healthy")],
  );
  const hang = catalog.refresh({ instance: "hang" });
  await started.promise;
  await catalog.refresh({ instance: "healthy" });
  expect(catalog.list({ instance: "healthy" }).models[0]?.id).toBe("coder");
  clock.expire();
  expect(await hang).toMatchObject([{ error: "timeout", stale: true }]);
  expect(catalog.list({ instance: "healthy" }).instances[0]?.error).toBeUndefined();
});

test("login change clears the old account immediately and ignores its late refresh", async () => {
  const old = deferred<readonly CatalogModel[]>();
  const fresh = deferred<readonly CatalogModel[]>();
  const started = deferred<void>();
  let calls = 0;
  const { catalog } = await setup(async (config) => {
    if (++calls === 1) return models();
    if (config.loginRevision === "account-1") {
      started.resolve();
      return old.promise;
    }
    return fresh.promise;
  });
  await catalog.refresh();
  const oldFlight = catalog.refresh();
  await started.promise;
  const newFlight = catalog.loginChanged("codex", "account-2");
  expect(catalog.list().models).toEqual([]);
  old.resolve(models("old-account"));
  await oldFlight;
  fresh.resolve(models("new-account"));
  await newFlight;
  expect(catalog.list().models[0]?.id).toBe("new-account");
});

test("changed persisted login revision cannot leak the previous account on restart", async () => {
  const first = await setup(async () => models());
  await first.catalog.refresh();
  await first.catalog.close();
  const fresh = deferred<readonly CatalogModel[]>();
  const catalog = new ModelCatalog({
    storage: openModelStorage(first.path),
    discover: () => fresh.promise,
    instances: [{ ...instance(), loginRevision: "account-2" }],
    now: () => first.clock.now,
    deadline: first.clock.deadline,
  });
  cleanups.push(() => catalog.close());
  expect(catalog.list().models).toEqual([]);
  fresh.resolve(models("fresh"));
  await catalog.refresh();
  expect(catalog.list().models[0]?.id).toBe("fresh");
});

test("malformed or mismatched discovery rows never replace the valid cache", async () => {
  let calls = 0;
  const { catalog } = await setup(async () =>
    ++calls === 1
      ? models()
      : models().map((model) => Object.assign({}, model, { instance: "wrong" })),
  );
  await catalog.refresh();
  expect(await catalog.refresh()).toMatchObject([{ error: "discovery_failed" }]);
  expect(catalog.list().models[0]?.instance).toBe("codex");
});

test("provider and instance filters page only their own models", async () => {
  const { catalog } = await setup(
    async (config) => ["a", "b", "c"].flatMap((id) => normalizeCodex(codexPayload(id), config)),
    [instance("codex", "one"), instance("claude", "two")],
  );
  await catalog.refresh();
  expect(catalog.list({ provider: "codex", limit: 2 })).toMatchObject({
    models: [{ id: "a" }, { id: "b" }],
    nextOffset: 2,
  });
  expect(
    catalog.list({ provider: "codex", offset: 2, limit: 2 }).models.map((model) => model.id),
  ).toEqual(["c"]);
  expect(catalog.list({ provider: "codex", instance: "two" }).models).toEqual([]);
  expect(catalog.list({ instance: "two" }).models.every((model) => model.instance === "two")).toBe(
    true,
  );
});

test("picker results cannot mutate the shared cached model", async () => {
  const { catalog } = await setup(async () => models());
  await catalog.refresh();
  const row = catalog.list().models[0];
  expect(() => {
    if (row) row.id = "corrupt";
  }).toThrow();
  expect(catalog.list().models[0]?.id).toBe("coder");
});

test("shutdown aborts discovery and closes only after pending flights settle", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const { catalog } = await setup(async (_, signal) => {
    signal.addEventListener("abort", () => aborted.resolve());
    started.resolve();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
  const flight = catalog.refresh();
  await started.promise;
  await catalog.close();
  await aborted.promise;
  await flight;
  await expect(catalog.refresh()).rejects.toThrow("closed");
});

test("removing an instance cancels its refresh and deletes its persisted choices", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const late = deferred<readonly CatalogModel[]>();
  let calls = 0;
  const { catalog, path } = await setup(async (_instance, signal) => {
    if (++calls === 1) return models();
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    return late.promise;
  });
  await catalog.refresh();
  const flight = catalog.refresh();
  await started.promise;
  const removal = catalog.removeInstance("codex");
  try {
    await aborted.promise;
    expect(catalog.list().models).toEqual([]);
    // Abort acknowledgement is the barrier: removal owns cleanup until the
    // cancelled discoverer releases its process, even if it returns late rows.
    late.resolve(models("removed"));
    await removal;
    await flight;
  } finally {
    late.resolve([]);
  }
  await catalog.close();
  const stored = openModelStorage(path);
  expect(stored.load()).toEqual([]);
  await stored.close();
});

test("catalog rejects an over-limit refresh and keeps its prior complete choices", async () => {
  let calls = 0;
  const { catalog } = await setup(async () =>
    ++calls === 1
      ? models()
      : Array.from({ length: 513 }, (_, index) => models(`model-${index}`)).flat(),
  );
  await catalog.refresh();
  expect(await catalog.refresh()).toMatchObject([{ error: "discovery_failed" }]);
  expect(catalog.list().models.map((row) => row.id)).toEqual(["coder"]);
});

test("instance admission is bounded and a removed account frees capacity", async () => {
  const configs = Array.from({ length: 64 }, (_, index) => instance("codex", `account-${index}`));
  const { catalog } = await setup(
    async (config) => normalizeCodex(codexPayload(), config),
    configs,
  );
  expect(() => catalog.registerInstance(instance("claude", "overflow"))).toThrow("limit");
  await catalog.removeInstance("account-0");
  catalog.registerInstance(instance("claude", "replacement"));
  await catalog.refresh({ instance: "replacement" });
  expect(catalog.list({ instance: "replacement" }).models[0]?.provider).toBe("claude");
});
