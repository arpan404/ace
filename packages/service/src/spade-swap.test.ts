import { expect, test } from "vitest";
import type { SpadeServiceState } from "./spade-registration.ts";
import {
  swapPrograms,
  swapSpade,
  type SpadeMaintenance,
  type SpadePendingSwap,
  type SpadeSwapPorts,
} from "./spade-swap.ts";

/**
 * A machine with Spade on it: which version `current` names, which one runs (and its pid),
 * whether admission is open, what is still working, and which version last migrated Spade's
 * database. A Spade refuses a database a newer version migrated, as real Spade does. `log`
 * records what happened to the machine, in order.
 */
function machine(options: {
  state?: SpadeServiceState;
  installed?: string;
  turns?: number;
  jobs?: number;
  /** How many polls a running turn takes to finish (or pause). */
  turnPolls?: number;
  migrations?: "ok" | "refuse";
  /** Versions that migrate the database on start, then crash. */
  broken?: string[];
  /** Versions that crash on start before touching the database. */
  dead?: string[];
  hasDatabase?: boolean;
  /** The restore puts the snapshot back (a broken restore leaves the migrated database). */
  restores?: boolean;
  /** Putting the snapshot back throws, after the live database was moved aside. */
  restoreThrows?: boolean;
  /**
   * The version the running process is at, when it isn't `installed`: an updater died after
   * flipping `current` and before restarting Spade, with admission still closed.
   */
  runs?: string;
  /** The record an interrupted swap left; its snapshot holds the database before it began. */
  pending?: SpadePendingSwap;
}) {
  const log: string[] = [];
  let clock = 0;
  let current = options.installed ?? "0.4.0";
  let running =
    options.state === "running" || options.state === undefined
      ? (options.runs ?? current)
      : undefined;
  let pid = running ? 100 : undefined;
  let schema = running ?? current;
  let admission: SpadeMaintenance["admission"] = options.runs ? "closed" : "open";
  let turns = options.turns ?? 0;
  const jobs = options.jobs ?? 0;
  let turnPolls = options.turnPolls ?? 1;
  const snapshots = new Map<string, string>();
  let pending = options.pending;
  if (pending?.snapshot !== undefined) snapshots.set(pending.snapshot, pending.from ?? schema);
  const status = (): SpadeMaintenance => ({
    admission,
    running_turns: turns,
    running_jobs: jobs,
  });
  const start = () => {
    running = undefined;
    // A version older than the database refuses to open it and exits.
    if (schema > current) return;
    if (options.dead?.includes(current)) return;
    // Starting migrates the database; a broken version crashes only after that.
    schema = current;
    if (options.broken?.includes(current)) return;
    running = current;
    pid = (pid ?? 100) + 1;
    admission = "open";
  };
  const ports: SpadeSwapPorts = {
    state: async () => options.state ?? "running",
    installedVersion: async () => current,
    async closeAdmission(mode, deadline) {
      log.push(`close ${mode} ${deadline}`);
      admission = "closed";
      return status();
    },
    async maintenance() {
      if (turns > 0 && --turnPolls <= 0) turns = 0;
      return status();
    },
    async reopenAdmission() {
      log.push("reopen");
      admission = "open";
    },
    async stage() {
      log.push("stage");
    },
    async snapshot() {
      if (options.hasDatabase === false) return undefined;
      log.push("snapshot");
      // The real port empties the snapshot folder first.
      snapshots.delete("snap");
      snapshots.set("snap", schema);
      return "snap";
    },
    async checkMigrations(snapshot) {
      log.push(`check ${snapshot}`);
      if (options.migrations === "refuse") throw new Error("schema 9 is newer than this build");
    },
    async restoreDatabase(snapshot, failed) {
      log.push(`restore ${snapshot}`);
      if (running) throw new Error("Spade is still running");
      if (options.restoreThrows) throw new Error("copyfile: no space left on device");
      const before = snapshots.get(snapshot) ?? schema;
      if (schema <= before) return undefined;
      if (options.restores !== false) schema = before;
      return `spade.sqlite.failed-${failed}`;
    },
    async removeSnapshot(snapshot) {
      snapshots.delete(snapshot);
    },
    async keepSnapshot(snapshot, failed) {
      const kept = `spade.sqlite.before-${failed}`;
      snapshots.set(kept, snapshots.get(snapshot) ?? schema);
      snapshots.delete(snapshot);
      return kept;
    },
    pendingSwap: async () => pending,
    async recordSwap(swap) {
      pending = swap;
    },
    async clearSwap() {
      pending = undefined;
    },
    async flip(version) {
      log.push(`flip ${version}`);
      current = version;
    },
    serverPid: async () => pid,
    async stop() {
      log.push("stop");
      running = undefined;
    },
    async restart() {
      log.push("restart");
      start();
    },
    health: async (version, oldPid) => running === version && pid !== oldPid,
    async wait(ms) {
      clock += ms;
    },
    now: () => clock,
  };
  return {
    ports,
    log,
    snapshots,
    current: () => current,
    running: () => running,
    schema: () => schema,
    admission: () => admission,
    pending: () => pending,
  };
}

test("an absent Spade service is skipped entirely", async () => {
  const world = machine({ state: "absent" });
  expect(await swapSpade("0.5.0", "idle", world.ports)).toEqual({
    kind: "skipped",
    reason: "absent",
  });
  expect(world.log).toEqual([]);
});

test("a Spade already at the release's version is left running", async () => {
  const world = machine({ installed: "0.5.0" });
  expect(await swapSpade("0.5.0", "idle", world.ports)).toMatchObject({ kind: "skipped" });
  expect(world.log).toEqual([]);
});

test("Spade pauses, checks its data with the new binary, flips, then restarts", async () => {
  const world = machine({ turns: 1, turnPolls: 3 });
  expect(await swapSpade("0.5.0", "now", world.ports)).toEqual({
    kind: "swapped",
    from: "0.4.0",
    to: "0.5.0",
  });
  expect(world.log).toEqual([
    "close now 30000",
    "stage",
    "snapshot",
    "check snap",
    "flip 0.5.0",
    "restart",
  ]);
  expect(world.running()).toBe("0.5.0");
  expect(world.snapshots.size).toBe(0);
});

test("idle mode waits for background jobs; when they outlast the deadline Spade stays put", async () => {
  const world = machine({ jobs: 1 });
  const result = await swapSpade("0.5.0", "idle", world.ports);
  expect(result).toMatchObject({ kind: "failed", from: "0.4.0", to: "0.5.0" });
  expect(result.kind === "failed" && result.error).toMatch(/idle/);
  expect(world.log).toEqual(["close idle 300000", "reopen"]);
  expect(world.current()).toBe("0.4.0");
  expect(world.admission()).toBe("open");
});

test("now mode doesn't wait for background jobs", async () => {
  const world = machine({ jobs: 2 });
  expect(await swapSpade("0.5.0", "now", world.ports)).toMatchObject({ kind: "swapped" });
});

test("a candidate that can't open Spade's data keeps the old version and reopens admission", async () => {
  const world = machine({ migrations: "refuse" });
  const result = await swapSpade("0.5.0", "idle", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(/schema 9 is newer/);
  expect(world.log).not.toContain("flip 0.5.0");
  expect(world.log.at(-1)).toBe("reopen");
  expect(world.current()).toBe("0.4.0");
  expect(world.running()).toBe("0.4.0");
  expect(world.snapshots.size).toBe(0);
});

test("a new Spade that doesn't come up is rolled back to the old one", async () => {
  const world = machine({ broken: ["0.5.0"] });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(/0.4.0 is running again/);
  expect(world.log.slice(-5)).toEqual(["restart", "stop", "restore snap", "flip 0.4.0", "restart"]);
  expect(world.current()).toBe("0.4.0");
  expect(world.running()).toBe("0.4.0");
  expect(world.snapshots.size).toBe(0);
});

test("after a new Spade migrated the database and failed, the old one gets its database back", async () => {
  const world = machine({ broken: ["0.5.0"] });
  await swapSpade("0.5.0", "now", world.ports);
  expect(world.schema()).toBe("0.4.0");
  expect(world.running()).toBe("0.4.0");
});

test("a rollback that put the database back says where the failed version's changes went", async () => {
  const world = machine({ broken: ["0.5.0"] });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(
    /set aside in spade\.sqlite\.failed-0\.5\.0/,
  );
});

test("a new Spade that failed before touching the schema leaves the live database in place", async () => {
  const world = machine({ dead: ["0.5.0"] });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(/0.4.0 is running again$/);
  expect(world.running()).toBe("0.4.0");
});

test("a rollback whose old Spade doesn't come back says so", async () => {
  const world = machine({ broken: ["0.5.0"], restores: false });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(
    /0.4.0 was restored but didn't come back up/,
  );
  expect(world.running()).toBeUndefined();
  expect(result.kind === "failed" && result.error).toMatch(
    /data from before the swap is in spade\.sqlite\.before-0\.5\.0/,
  );
  expect(world.snapshots.get("spade.sqlite.before-0.5.0")).toBe("0.4.0");
});

test("a rollback that couldn't put the database back keeps the only good copy", async () => {
  const world = machine({ broken: ["0.5.0"], restoreThrows: true });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(/restoring Spade 0.4.0 failed/);
  expect(result.kind === "failed" && result.error).toMatch(/spade\.sqlite\.before-0\.5\.0/);
  expect(world.snapshots.get("spade.sqlite.before-0.5.0")).toBe("0.4.0");
});

test("an update that died after the flip is finished on the retry", async () => {
  // `current` names 0.5.0, but the old 0.4.0 process still runs with admission closed.
  const world = machine({ installed: "0.5.0", runs: "0.4.0" });
  expect(await swapSpade("0.5.0", "now", world.ports)).toMatchObject({
    kind: "swapped",
    to: "0.5.0",
  });
  expect(world.log).toEqual(["close now 30000", "restart"]);
  expect(world.running()).toBe("0.5.0");
  expect(world.admission()).toBe("open");
});

test("a retry in idle mode waits for Spade's work before finishing an interrupted update", async () => {
  const world = machine({ installed: "0.5.0", runs: "0.4.0", jobs: 1 });
  const result = await swapSpade("0.5.0", "idle", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(/idle/);
  expect(world.log).toEqual(["close idle 300000", "reopen"]);
  expect(world.running()).toBe("0.4.0");
  expect(world.admission()).toBe("open");
});

test("a retry in now mode lets running model steps finish before the restart", async () => {
  const world = machine({ installed: "0.5.0", runs: "0.4.0", turns: 1, turnPolls: 3, jobs: 1 });
  expect(await swapSpade("0.5.0", "now", world.ports)).toMatchObject({ kind: "swapped" });
  expect(world.log).toEqual(["close now 30000", "restart"]);
});

const interrupted: SpadePendingSwap = { from: "0.4.0", to: "0.5.0", snapshot: "snap" };

test("a retry whose new version fails rolls back to the version the swap's record names", async () => {
  const world = machine({
    installed: "0.5.0",
    runs: "0.4.0",
    broken: ["0.5.0"],
    pending: interrupted,
  });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result).toMatchObject({ kind: "failed", from: "0.4.0", to: "0.5.0" });
  expect(world.current()).toBe("0.4.0");
  expect(world.running()).toBe("0.4.0");
  expect(world.schema()).toBe("0.4.0");
  expect(world.pending()).toBeUndefined();
});

test("a retry that can't restore the database keeps the interrupted swap's snapshot", async () => {
  const world = machine({
    installed: "0.5.0",
    runs: "0.4.0",
    broken: ["0.5.0"],
    restoreThrows: true,
    pending: interrupted,
  });
  await swapSpade("0.5.0", "now", world.ports);
  expect(world.snapshots.get("spade.sqlite.before-0.5.0")).toBe("0.4.0");
  // A later update's snapshot can't replace it.
  await swapSpade("0.6.0", "now", world.ports);
  expect(world.snapshots.get("spade.sqlite.before-0.5.0")).toBe("0.4.0");
});

test("a swap to a newer version first keeps an interrupted swap's snapshot", async () => {
  const world = machine({ installed: "0.5.0", runs: "0.5.0", pending: interrupted });
  expect(await swapSpade("0.6.0", "now", world.ports)).toMatchObject({ kind: "swapped" });
  expect(world.snapshots.get("spade.sqlite.before-0.5.0")).toBe("0.4.0");
});

test("a swap's record is written before the flip and gone once it is done", async () => {
  const world = machine({});
  const flip = world.ports.flip;
  let recorded: SpadePendingSwap | undefined;
  world.ports.flip = async (version) => {
    recorded = world.pending();
    await flip(version);
  };
  await swapSpade("0.5.0", "now", world.ports);
  expect(recorded).toEqual({ from: "0.4.0", to: "0.5.0", snapshot: "snap" });
  expect(world.pending()).toBeUndefined();
});

test("a retry that can't bring the flipped version up reports the update failed", async () => {
  const world = machine({ installed: "0.5.0", runs: "0.4.0", dead: ["0.5.0"] });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(/finishing an interrupted update/);
});

test("now mode waits past Spade's 30 s step allowance to see Spade pause its turns", async () => {
  // Spade pauses the turn when its own 30 s allowance ends; the poll that sees it comes later.
  const world = machine({ turns: 1, turnPolls: 64 });
  expect(await swapSpade("0.5.0", "now", world.ports)).toMatchObject({ kind: "swapped" });
});

test("a stopped Spade is swapped without asking it to pause", async () => {
  const world = machine({ state: "stopped" });
  expect(await swapSpade("0.5.0", "idle", world.ports)).toMatchObject({ kind: "swapped" });
  expect(world.log[0]).toBe("stage");
});

test("Spade with no database yet skips the migration check", async () => {
  const world = machine({ hasDatabase: false });
  expect(await swapSpade("0.5.0", "now", world.ports)).toMatchObject({ kind: "swapped" });
  expect(world.log).not.toContain("check snap");
});

test("the daemon swaps first, then Spade, and a daemon failure leaves Spade alone", async () => {
  const order: string[] = [];
  const world = machine({});
  const spade = async () => {
    order.push("spade");
    return swapSpade("0.5.0", "now", world.ports);
  };
  const done = await swapPrograms({
    daemon: async () => {
      order.push(`daemon while Spade runs ${world.running()}`);
      return "updated";
    },
    spade,
  });
  expect(order).toEqual(["daemon while Spade runs 0.4.0", "spade"]);
  expect(done.spade).toMatchObject({ kind: "swapped" });

  const untouched = machine({});
  await expect(
    swapPrograms({
      daemon: async () => {
        throw new Error("Candidate health check failed");
      },
      spade: () => swapSpade("0.5.0", "now", untouched.ports),
    }),
  ).rejects.toThrow(/health/);
  expect(untouched.log).toEqual([]);
});

test("a Spade failure doesn't undo the daemon's update", async () => {
  const world = machine({ migrations: "refuse" });
  const done = await swapPrograms({
    daemon: async () => "updated" as const,
    spade: () => swapSpade("0.5.0", "now", world.ports),
  });
  expect(done.daemon).toBe("updated");
  expect(done.spade.kind).toBe("failed");
});
