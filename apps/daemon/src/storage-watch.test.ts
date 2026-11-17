import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MaintenanceGate } from "@ace/service";
import { Command } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { StorageWatch } from "./storage-watch.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

const MiB = 1024 * 1024;
const levels = { pauseBelow: 256 * MiB, resumeAt: 512 * MiB, warnBelow: 1024 * MiB };

/** A watch on a real temp database whose growth a test can cap, with time and space by hand. */
function setup(freeMiB = 10_000) {
  const home = mkdtempSync(join(tmpdir(), "ace-storage-watch-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "events.sqlite"));
  cleanup.push(() => db.close());
  db.exec("CREATE TABLE t(x)");
  let free = freeMiB * MiB;
  const timers: { run: () => void; ms: number }[] = [];
  const lines: { level: string; message: string }[] = [];
  const watch = new StorageWatch({
    home,
    diskSpace: () => ({ bavail: free / 4096, bsize: 4096 }),
    delay: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer) >>> 0, 1);
    },
    log: { log: (level, message) => lines.push({ level, message }) },
    levels,
    // The probe writes where the test's disk is: the capped database.
    probe: () => db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(8192)),
  });
  cleanup.push(() => watch.close());
  const gate = new MaintenanceGate(() => 0);
  watch.attach(gate);
  watch.start();
  return {
    watch,
    gate,
    lines,
    timers,
    setFree(mib: number) {
      free = mib * MiB;
    },
    /** Fire the one pending free-space read, as its timer would. */
    tick() {
      const timer = timers.shift();
      if (!timer) throw new Error("No free-space read scheduled");
      timer.run();
      return timer.ms;
    },
    /** Write until SQLite refuses for want of room: a genuine SQLITE_FULL. */
    fill(): unknown {
      const pages = Number(db.prepare("PRAGMA page_count").get()?.page_count);
      db.exec(`PRAGMA max_page_count=${pages}`);
      try {
        for (;;) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(8192));
      } catch (error) {
        return error;
      }
    },
    /** Free the database again, as deleting files frees the volume. */
    unfill() {
      db.exec("PRAGMA max_page_count=1073741823");
      db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(8192));
    },
  };
}

const create = Command.parse({
  id: "new-thread",
  deviceId: "device",
  payload: {
    type: "thread.create",
    workspaceId: "w",
    provider: "codex",
    title: "t",
    input: [{ type: "text", text: "go" }],
  },
});
const interrupt = Command.parse({
  id: "interrupt",
  deviceId: "device",
  payload: { type: "thread.interrupt", threadId: "thread" },
});

test("a write that fails on a full disk holds new work, keeps stops working, and heals once space is back", () => {
  const state = setup(10_000);
  expect(state.gate.admitCommand(create)).toBe(true);
  // The database cannot grow: SQLite's own SQLITE_FULL, reported the way the daemon hears it.
  const error = state.fill();
  expect(state.watch.observe(new Error("Live writes failed; retrying", { cause: error }))).toBe(
    true,
  );
  expect(state.gate.status().holds).toEqual(["storage"]);
  expect(state.gate.admitCommand(create)).toBe(false);
  expect(state.gate.admitCommand(interrupt)).toBe(true);
  expect(state.lines.filter((line) => line.level === "error")).toHaveLength(1);
  // A second failure while held tells no one again.
  state.watch.observe(state.fill());
  expect(state.lines.filter((line) => line.level === "error")).toHaveLength(1);

  // Space is freed: the next read, due soon rather than in a minute, lets new work in.
  let heard = 0;
  state.watch.onRoom(() => heard++);
  state.unfill();
  state.setFree(2_000);
  expect(state.tick()).toBe(5_000);
  expect(state.gate.status().holds).toEqual([]);
  expect(state.gate.admitCommand(create)).toBe(true);
  expect(heard).toBe(1);
  expect(state.tick()).toBe(60_000);
});

test("free space under the pause level holds new work before any write fails, and a sliver back is not enough", () => {
  const state = setup(10_000);
  state.setFree(200);
  state.tick();
  expect(state.gate.status().holds).toEqual(["storage"]);
  state.setFree(300);
  state.tick();
  expect(state.gate.status().holds).toEqual(["storage"]);
  state.setFree(600);
  state.tick();
  expect(state.gate.status().holds).toEqual([]);
});

test("low space only warns, once", () => {
  const state = setup(10_000);
  state.setFree(800);
  state.tick();
  state.tick();
  expect(state.gate.status().holds).toEqual([]);
  expect(state.lines.filter((line) => line.message === "Disk space is low")).toHaveLength(1);
});

test("a failure that is not the disk's leaves new work alone", () => {
  const state = setup(10_000);
  expect(state.watch.observe(new Error("UNIQUE constraint failed"))).toBe(false);
  expect(state.watch.observe(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
  expect(state.gate.status().holds).toEqual([]);
});

test("a file write that runs out of room or quota counts as a full disk", () => {
  const state = setup(10_000);
  expect(state.watch.observe(Object.assign(new Error("no space"), { code: "EDQUOT" }))).toBe(true);
  expect(state.gate.status().holds).toEqual(["storage"]);
});

test("a gate attached while the disk is already full is held at once", () => {
  const state = setup(100);
  const late = new MaintenanceGate(() => 0);
  state.watch.attach(late);
  expect(late.status().holds).toEqual(["storage"]);
});

test("a quota free space can't show keeps new work held until a write goes through again", () => {
  const state = setup(10_000);
  // Writes are refused while the volume still reads plenty of room, as under a per-user quota.
  state.watch.observe(state.fill());
  expect(state.gate.status().holds).toEqual(["storage"]);
  state.setFree(2_000);
  state.tick();
  state.tick();
  expect(state.gate.status().holds).toEqual(["storage"]);
  expect(state.lines.some((line) => line.message.startsWith("Disk space is back"))).toBe(false);

  state.unfill();
  expect(state.tick()).toBe(5_000);
  expect(state.gate.status().holds).toEqual([]);
});
