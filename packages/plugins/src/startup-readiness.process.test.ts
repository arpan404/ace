import { mkdtemp, mkdir, access, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PluginManager } from "./index.ts";

test("opening the plugin index does not wait for or acquire the maintenance lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-plugin-ready-"));
  const options = { root: join(root, "ace"), now: () => 0, id: () => "unused" };
  const initial = await PluginManager.open(options);
  initial.close();
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
  } finally {
    lock.close();
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
