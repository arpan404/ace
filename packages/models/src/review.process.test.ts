import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ModelResolution } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import {
  ModelCatalog,
  createModelDiscovery,
  normalizeCodex,
  openModelStorage,
  resolveModel,
  type CatalogModel,
} from "./index.ts";
import { Clock, codexPayload, deferred, fakeCli, instance, workspace } from "./testing/support.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
test("failed durable removal is reported and retried before shutdown and restart", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const path = join(work.path, "cache.sqlite");
  const clock = new Clock();
  const catalog = new ModelCatalog({
    storage: openModelStorage(path),
    instances: [instance()],
    discover: async () => normalizeCodex(codexPayload("a"), instance()),
    now: () => clock.now,
    deadline: clock.deadline,
  });
  cleanups.push(() => catalog.close());
  await catalog.refresh();
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER reject_delete BEFORE DELETE ON model_catalog BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  try {
    await expect(Promise.resolve(catalog.removeInstance("codex"))).rejects.toThrow("persistence");
    expect(catalog.list().models).toEqual([]);
    await expect(catalog.close()).rejects.toThrow("persistence");
  } finally {
    db.exec("DROP TRIGGER reject_delete");
    db.close();
  }
  await catalog.close();
  const restarted = new ModelCatalog({
    storage: openModelStorage(path),
    instances: [instance()],
    discover: async () => {
      throw new Error("offline");
    },
    now: () => clock.now,
    deadline: clock.deadline,
  });
  cleanups.push(() => restarted.close());
  expect(restarted.list().models).toEqual([]);
});

test("maximum-length policy fields produce a schema-valid concrete resolution", () => {
  const id = "m".repeat(256);
  const tier = "t".repeat(256);
  const effort = "e".repeat(256);
  const rows = normalizeCodex(
    {
      data: [
        {
          id: "catalog",
          defaultReasoningEffort: effort,
          model: id,
          displayName: "Long model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: effort }],
          serviceTiers: [{ id: tier, name: "Long tier" }],
        },
      ],
    },
    instance(),
  );
  const result = resolveModel(
    { role: "r".repeat(256), model: id, tier, effort },
    rows,
    () => false,
  );
  expect(result).toMatchObject({ ok: true, model: { id }, tier: { id: tier }, effort });
  expect(ModelResolution.safeParse(result).success).toBe(true);
});

test("duplicate policy preferences preserve the first occurrence's priority", () => {
  const rows = ["b", "a"].flatMap((id) => normalizeCodex(codexPayload(id, false), instance()));
  expect(
    resolveModel(
      { role: "coder", selection: "strongest", preferenceOrder: ["a", "b", "a"] },
      rows,
      () => false,
    ),
  ).toMatchObject({ ok: true, model: { id: "a" } });
});

test("close reaps an owned hung app-server with synchronous storage", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const script = await fakeCli(work.path);
  const ready = deferred<void>();
  let reaped = false;
  const clock = new Clock();
  const catalog = new ModelCatalog({
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    instances: [{ ...instance(), cwd: work.path, args: [script], env: { FAKE_PROVIDER: "hang" } }],
    discover: createModelDiscovery({
      spawn(options) {
        const proc = spawnSupervised(options);
        // The process announces readiness, proving it exists before close starts.
        proc.stdout.on("line", () => ready.resolve());
        void proc.exited.then(() => {
          reaped = true;
        });
        cleanups.push(() => proc.stop({ graceMs: 0 }));
        return proc;
      },
    }),
    now: () => clock.now,
    deadline: clock.deadline,
  });
  const flight = catalog.refresh();
  await ready.promise;
  await catalog.close();
  expect(reaped).toBe(true);
  await flight;
});

test("queued refreshes cannot exceed the bound on unsettled discovery resources", async () => {
  const clock = new Clock();
  const held: ReturnType<typeof deferred<readonly CatalogModel[]>>[] = [];
  let started = deferred<void>();
  const catalog = new ModelCatalog({
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    instances: [instance("codex", "one"), instance("codex", "two")],
    discover: () => {
      const result = deferred<readonly CatalogModel[]>();
      held.push(result);
      started.resolve();
      return result.promise;
    },
    now: () => clock.now,
    deadline: clock.deadline,
  });
  try {
    for (let i = 0; i < 63; i++) {
      started = deferred<void>();
      const flight = catalog.refresh({ instance: "one" });
      await started.promise;
      clock.expire();
      expect(await flight).toMatchObject([{ error: "timeout" }]);
    }
    started = deferred<void>();
    const first = catalog.refresh({ instance: "one" });
    const second = catalog.refresh({ instance: "two" });
    await started.promise;
    clock.expire();
    expect(await first).toMatchObject([{ error: "timeout" }]);
    expect(await second).toMatchObject([{ error: "discovery_failed" }]);
  } finally {
    for (const result of held) result.resolve([]);
    await catalog.close();
  }
});
