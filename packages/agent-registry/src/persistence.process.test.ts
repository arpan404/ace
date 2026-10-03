import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  AgentRegistry,
  AgentCatalog,
  fileCache,
  fileInventoryStorage,
  type InventoryStorage,
} from "./index.ts";
import { temporary, body, sample } from "./testing/support.ts";

async function setup(root: string, storage: InventoryStorage) {
  const catalog = await AgentCatalog.open({
    cache: fileCache(join(root, "cache.json"), () => "cache"),
    now: () => 1,
    target: "linux-x86_64",
    fetch: async () => new Response(body([sample()])),
  });
  const registry = await AgentRegistry.open({
    catalog,
    storage,
    root: join(root, "installations"),
    target: "linux-x86_64",
    env: {},
    runtime: { fetch: async () => new Response("synthetic artifact") },
  });
  await catalog.refresh();
  return registry;
}
async function install(registry: AgentRegistry) {
  const preview = await registry.handle({
    type: "registry.install-plan",
    requestId: "preview",
    acpAgentId: "official:sample",
    runtime: "binary",
  });
  if (!preview.result.ok || !("plan" in preview.result)) throw new Error("No plan");
  return registry.handle({
    type: "registry.install-intent",
    requestId: "install",
    intentId: "approved",
    digest: preview.result.plan.digest,
  });
}
test("cancellation cannot acknowledge rollback after inventory publication begins", async () => {
  const work = await temporary();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const disk = fileInventoryStorage(join(work.root, "inventory.json"), () => "write");
  const registry = await setup(work.root, {
    ...disk,
    async save(entries) {
      started.resolve();
      await release.promise;
      await disk.save(entries);
    },
  });
  try {
    const pending = install(registry);
    await Promise.race([
      started.promise,
      pending.then((result) => {
        throw new Error("Install ended before publication", { cause: result });
      }),
    ]);
    expect(
      (
        await registry.handle({
          type: "registry.install-cancel",
          requestId: "cancel",
          intentId: "approved",
        })
      ).result,
    ).toEqual({ ok: true, cancelled: false });
    release.resolve();
    const result = await pending;
    expect(result.result.ok).toBe(true);
    expect(registry.inventory.list()).toHaveLength(1);
  } finally {
    release.resolve();
    await registry.close();
    await work.close();
  }
});
test("post-rename durability failure retains the published artifact across restart", async () => {
  const work = await temporary();
  const path = join(work.root, "inventory.json");
  const disk = fileInventoryStorage(path, () => "write", {
    syncDirectory: async () => {
      throw new Error("Injected directory sync failure");
    },
  });
  const registry = await setup(work.root, disk);
  try {
    expect((await install(registry)).result).toMatchObject({ ok: true, durability: "uncertain" });
    await registry.close();
    const restarted = await setup(
      work.root,
      fileInventoryStorage(path, () => "restart"),
    );
    try {
      const installed = restarted.inventory.list()[0];
      if (!installed) throw new Error("Missing committed installation");
      expect(await readFile((await restarted.resolve(installed)).command, "utf8")).toBe(
        "synthetic artifact",
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await registry.close();
    await work.close();
  }
});
