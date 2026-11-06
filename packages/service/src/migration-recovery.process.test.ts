import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
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
  const path = join(root, "events.sqlite");
  const setup = new DatabaseSync(path);
  setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE content(value BLOB)");
  const insert = setup.prepare("INSERT INTO content VALUES(randomblob(4000))");
  setup.exec("BEGIN");
  // About 24 MB: dozens of backup steps, each one a chance for a write to restart the copy.
  for (let row = 0; row < 6_000; row++) insert.run();
  setup.exec("COMMIT");
  setup.close();
  // The daemon writes from its own process, so writes go on even while a copy step holds the
  // updater's thread (Bun copies in one synchronous step).
  const writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.env.ACE_DB, { timeout: 5000 });
      const insert = db.prepare("INSERT INTO content VALUES(randomblob(4000))");
      let first = true;
      setInterval(() => {
        insert.run();
        if (first) process.stdout.write("writing\\n");
        first = false;
      }, 1);`,
    ],
    { env: { ...process.env, ACE_DB: path }, stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(writer, "exit");
  try {
    await once(writer.stdout, "data");
    const snapshot = join(root, "snapshot");
    const finished = snapshotDatabases(root, snapshot).then(() => "finished" as const);
    const stalled = new Promise<"stalled">((resolve) =>
      setTimeout(resolve, 30_000, "stalled").unref(),
    );
    expect(await Promise.race([finished, stalled])).toBe("finished");
    // Writes continue after the copy, so the live database ends up ahead of it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    writer.kill();
    await exited;
    const copy = new DatabaseSync(join(snapshot, "events.sqlite"), { readOnly: true });
    const live = new DatabaseSync(path, { readOnly: true });
    try {
      expect(copy.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      const copied = Number(copy.prepare("SELECT count(*) AS rows FROM content").get()?.rows);
      const current = Number(live.prepare("SELECT count(*) AS rows FROM content").get()?.rows);
      expect(copied).toBeGreaterThanOrEqual(6_000);
      expect(copied).toBeLessThan(current);
    } finally {
      copy.close();
      live.close();
    }
  } finally {
    writer.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
