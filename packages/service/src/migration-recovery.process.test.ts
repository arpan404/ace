import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicPointer,
  recoverUpdate,
  snapshotDatabases,
  restoreDatabases,
  type UpdatePorts,
} from "./index.ts";

test.each(["empty", "missing models"])(
  "%s rollback inventory preserves all live databases",
  async (damage) => {
    const root = await mkdtemp(join(tmpdir(), "ace-inventory-"));
    try {
      const old = "releases/1.0.0-linux-x64",
        candidate = "releases/1.1.0-linux-x64";
      await mkdir(join(root, candidate), { recursive: true });
      await atomicPointer(join(root, "current"), candidate);
      for (const name of ["events.sqlite", "models.sqlite"]) {
        const db = new DatabaseSync(join(root, name));
        db.exec("CREATE TABLE content(value TEXT); INSERT INTO content VALUES('live')");
        db.close();
      }
      const snapshot = join(root, ".rollback-db");
      await snapshotDatabases(root, snapshot);
      await rm(join(snapshot, "models.sqlite"));
      if (damage === "empty") await rm(join(snapshot, "events.sqlite"));
      await writeFile(
        join(root, "update.json"),
        JSON.stringify({
          old,
          candidate,
          version: "1.0.0",
          stage: "snapshotted",
          databases: ["events.sqlite", "models.sqlite"],
        }),
      );
      const ports: UpdatePorts = {
        stop: async () => {},
        start: async () => {
          throw new Error("must remain stopped on invalid recovery");
        },
        health: async () => true,
        maintenance: async () => ({ draining: true, blockers: 0 }),
        migrate: async () => {},
        wait: async () => {},
        now: () => 0,
      };
      await expect(recoverUpdate(root, root, ports)).rejects.toThrow("inventory");
      for (const name of ["events.sqlite", "models.sqlite"]) {
        const db = new DatabaseSync(join(root, name), { readOnly: true });
        try {
          expect(db.prepare("SELECT value FROM content").get()?.value).toBe("live");
        } finally {
          db.close();
        }
      }
      expect(await readlink(join(root, "current"))).toBe(candidate);
      expect(JSON.parse(await readFile(join(root, "update.json"), "utf8"))).toMatchObject({
        databases: ["events.sqlite", "models.sqlite"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("an explicitly empty original inventory can remove databases introduced by a failed candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-empty-inventory-"));
  try {
    const snapshot = join(root, "snapshot");
    const inventory = await snapshotDatabases(root, snapshot);
    await writeFile(join(root, "candidate.sqlite"), "new candidate data");
    await writeFile(join(root, "config"), "preserve configuration");
    await restoreDatabases(root, snapshot, inventory);
    await expect(readFile(join(root, "candidate.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, "config"), "utf8")).toBe("preserve configuration");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
