import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProviderDb } from "./provider-db.ts";
import {
  SnapshotBusy,
  SnapshotRefused,
  SnapshotScratch,
  type FreeSpaceProbe,
} from "./snapshot-scratch.ts";
import type { ProviderHome } from "./contracts.ts";

const GiB = 1024 ** 3;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const plenty: FreeSpaceProbe = async () => ({ available: 500 * GiB, total: 1000 * GiB });
const noClone = async () => false;

async function fixture(options: { wal: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "ace-snapshot-"));
  const home = join(root, "opencode");
  const scratchRoot = join(root, "ace");
  await mkdir(home);
  await mkdir(scratchRoot);
  const path = join(home, "opencode.db");
  const writer = new DatabaseSync(path);
  if (options.wal) writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  writer.exec("CREATE TABLE session(id TEXT, title TEXT)");
  writer.prepare("INSERT INTO session VALUES(?,?)").run("s1", "first");
  cleanup.push(async () => {
    if (writer.isOpen) writer.close();
    await rm(root, { recursive: true, force: true });
  });
  const instance: ProviderHome = {
    id: "oc",
    provider: "opencode",
    homeDir: home,
    offlineSnapshot: false,
  };
  const stages = async () =>
    (await readdir(scratchRoot)).filter((name) => name.startsWith("sqlite-read-"));
  return { root, home, path, scratchRoot, writer, instance, stages };
}

test("low free space refuses the snapshot before writing and frees the slot", async () => {
  const f = await fixture({ wal: true });
  let available = 5 * GiB;
  const scratch = new SnapshotScratch(f.scratchRoot, {
    clone: noClone,
    freeSpace: async () => ({ available, total: 100 * GiB }),
  });
  const refused = openProviderDb(f.instance, f.path, scratch, new AbortController().signal);
  await expect(refused).rejects.toBeInstanceOf(SnapshotRefused);
  await expect(refused).rejects.toThrow("would leave less than 5.0 GB free");
  expect(await f.stages()).toEqual([]);

  available = 50 * GiB;
  const handle = await openProviderDb(f.instance, f.path, scratch, new AbortController().signal);
  expect(handle.db.prepare("SELECT title FROM session").get()?.title).toBe("first");
  await handle.close();
  expect(await f.stages()).toEqual([]);
});

test("a source larger than the snapshot cap is refused with no scratch left behind", async () => {
  const f = await fixture({ wal: true });
  const scratch = new SnapshotScratch(f.scratchRoot, {
    clone: noClone,
    freeSpace: plenty,
    policy: { maxCopyBytes: 1024 },
  });
  await expect(
    openProviderDb(f.instance, f.path, scratch, new AbortController().signal),
  ).rejects.toThrow("above the 1 MB snapshot limit");
  expect(await f.stages()).toEqual([]);
});

test("aborting mid-copy deletes the partial snapshot", async () => {
  const f = await fixture({ wal: false });
  f.writer.close();
  // A large sparse source keeps the streamed copy running across many event-loop turns.
  await writeFile(f.path, "");
  await truncate(f.path, 512 * 1024 * 1024);
  const scratch = new SnapshotScratch(f.scratchRoot, { clone: noClone, freeSpace: plenty });
  const controller = new AbortController();
  const opening = openProviderDb(f.instance, f.path, scratch, controller.signal);
  const settled = opening.then(
    () => "opened",
    () => "rejected",
  );
  let copied = false;
  while (!copied) {
    const [stage] = await f.stages();
    if (stage) {
      const size = await stat(join(f.scratchRoot, stage, "snapshot.sqlite")).then(
        (info) => info.size,
        () => 0,
      );
      copied = size > 0;
    }
    if ((await Promise.race([settled, setImmediate("pending")])) !== "pending") break;
  }
  expect(copied).toBe(true);
  controller.abort();
  await expect(opening).rejects.toThrow();
  expect(await f.stages()).toEqual([]);
});

test("concurrent opens never hold two snapshots at once", async () => {
  const f = await fixture({ wal: true });
  const scratch = new SnapshotScratch(f.scratchRoot, { clone: noClone, freeSpace: plenty });
  const signal = new AbortController().signal;
  const results = await Promise.allSettled([
    openProviderDb(f.instance, f.path, scratch, signal),
    openProviderDb(f.instance, f.path, scratch, signal),
  ]);
  const opened = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const busy = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  expect(opened).toHaveLength(1);
  expect(busy).toHaveLength(1);
  expect(busy[0]).toBeInstanceOf(SnapshotBusy);
  expect(await f.stages()).toHaveLength(1);
  await opened[0]?.close();
  expect(await f.stages()).toEqual([]);
  const next = await openProviderDb(f.instance, f.path, scratch, signal);
  expect(next.db.prepare("SELECT count(*) AS n FROM session").get()?.n).toBe(1);
  await next.close();
});

test("a snapshot sweeps stages of dead processes but keeps a live process's stage", async () => {
  const f = await fixture({ wal: true });
  for (const name of ["sqlite-read-111-dead", "sqlite-read-222-live", "sqlite-read-legacy"])
    await mkdir(join(f.scratchRoot, name));
  const scratch = new SnapshotScratch(f.scratchRoot, {
    clone: noClone,
    freeSpace: plenty,
    pid: 333,
    isAlive: (pid) => pid === 222,
  });
  const handle = await openProviderDb(f.instance, f.path, scratch, new AbortController().signal);
  const stages = await f.stages();
  expect(stages).toContain("sqlite-read-222-live");
  expect(stages.filter((name) => name.startsWith("sqlite-read-333-"))).toHaveLength(1);
  expect(stages).toHaveLength(2);
  await handle.close();
  expect(await f.stages()).toEqual(["sqlite-read-222-live"]);
});

test("a quiescent WAL database is read in place without any scratch copy", async () => {
  const f = await fixture({ wal: true });
  f.writer.close(); // The last connection checkpoints and removes the WAL.
  const scratch = new SnapshotScratch(f.scratchRoot, {
    clone: noClone,
    freeSpace: async () => {
      throw new Error("an in-place read must not need scratch space");
    },
  });
  const handle = await openProviderDb(f.instance, f.path, scratch, new AbortController().signal);
  expect(await f.stages()).toEqual([]);
  expect(handle.db.prepare("SELECT title FROM session").get()?.title).toBe("first");
  await handle.verify();
  await handle.close();
  expect(await readdir(f.home)).toEqual(["opencode.db"]);
});

test("an in-place read rejects rows that a concurrent checkpoint may have torn", async () => {
  const f = await fixture({ wal: true });
  f.writer.close();
  const scratch = new SnapshotScratch(f.scratchRoot, { clone: noClone, freeSpace: plenty });
  const handle = await openProviderDb(f.instance, f.path, scratch, new AbortController().signal);
  const writer = new DatabaseSync(f.path);
  writer.prepare("INSERT INTO session VALUES(?,?)").run("s2", "second");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.close();
  await expect(handle.verify()).rejects.toThrow("changed during snapshot");
  await handle.close();
});
