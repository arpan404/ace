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

test("a rollback snapshot finishes as one consistent copy while another connection keeps writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-snapshot-writer-"));
  const writer = new DatabaseSync(join(root, "events.sqlite"));
  let writes: ReturnType<typeof setInterval> | undefined;
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE content(value BLOB)");
    const insert = writer.prepare("INSERT INTO content VALUES(randomblob(4000))");
    writer.exec("BEGIN");
    // About 24 MB: dozens of backup steps, each one a chance for a write to restart the copy.
    for (let row = 0; row < 6_000; row++) insert.run();
    writer.exec("COMMIT");
    writes = setInterval(() => insert.run(), 1);
    const snapshot = join(root, "snapshot");
    const finished = snapshotDatabases(root, snapshot).then(() => "finished" as const);
    const stalled = new Promise<"stalled">((resolve) =>
      setTimeout(resolve, 30_000, "stalled").unref(),
    );
    expect(await Promise.race([finished, stalled])).toBe("finished");
    clearInterval(writes);
    const copy = new DatabaseSync(join(snapshot, "events.sqlite"), { readOnly: true });
    try {
      expect(copy.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      const copied = Number(copy.prepare("SELECT count(*) AS rows FROM content").get()?.rows);
      const live = Number(writer.prepare("SELECT count(*) AS rows FROM content").get()?.rows);
      expect(copied).toBeGreaterThanOrEqual(6_000);
      expect(copied).toBeLessThan(live);
    } finally {
      copy.close();
    }
  } finally {
    clearInterval(writes);
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});
