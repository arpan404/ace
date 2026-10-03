import { mkdir, access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PluginManager } from "./index.ts";
import { fixture } from "./test-support.ts";

test("opening the plugin index does not wait for or acquire the maintenance lock", async () => {
  const f = await fixture();
  const options = { root: f.managerRoot, now: () => 123, id: () => "unused" };
  const review = await f.prepare();
  await f.manager.accept(review);
  f.manager.close();
  const abandoned = join(options.root, "fetch", "abandoned");
  await mkdir(abandoned);
  const lock = new DatabaseSync(join(options.root, "operation.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  const manager = await PluginManager.openIndex(options);
  try {
    await access(abandoned);
    await expect(manager.maintain(new AbortController().signal)).rejects.toThrow("busy");
    lock.exec("ROLLBACK");
    await manager.maintain(new AbortController().signal);
    await expect(access(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.list()).toEqual([
      { name: "sample", version: "1.0", commit: review.commit, hash: review.hash, acceptedAt: 123 },
    ]);
    expect((await manager.installed())[0]?.text["rules/style.md"]).toBe("Use TypeScript.");
  } finally {
    lock.close();
    manager.close();
    await f.close();
  }
});
