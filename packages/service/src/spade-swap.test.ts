import { expect, test } from "vitest";
import type { SpadeServiceState } from "./spade-registration.ts";
import {
  swapPrograms,
  swapSpade,
  type SpadeMaintenance,
  type SpadeSwapPorts,
} from "./spade-swap.ts";

/**
 * A machine with Spade on it: which version `current` names, which one runs, whether admission
 * is open, and what is still working. `log` records what happened to the machine, in order.
 */
function machine(options: {
  state?: SpadeServiceState;
  installed?: string;
  turns?: number;
  jobs?: number;
  /** How many polls a running turn takes to finish (or pause). */
  turnPolls?: number;
  migrations?: "ok" | "refuse";
  healthy?: boolean;
  hasDatabase?: boolean;
}) {
  const log: string[] = [];
  let clock = 0;
  let current = options.installed ?? "0.4.0";
  let running = options.state === "running" || options.state === undefined ? current : undefined;
  let admission: SpadeMaintenance["admission"] = "open";
  let turns = options.turns ?? 0;
  const jobs = options.jobs ?? 0;
  let turnPolls = options.turnPolls ?? 1;
  const snapshots = new Set<string>();
  const status = (): SpadeMaintenance => ({
    admission,
    running_turns: turns,
    running_jobs: jobs,
  });
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
      snapshots.add("snap");
      return "snap";
    },
    async checkMigrations(snapshot) {
      log.push(`check ${snapshot}`);
      if (options.migrations === "refuse") throw new Error("schema 9 is newer than this build");
    },
    async removeSnapshot(snapshot) {
      snapshots.delete(snapshot);
    },
    async flip(version) {
      log.push(`flip ${version}`);
      current = version;
    },
    async restart() {
      log.push("restart");
      running = current;
      admission = "open";
    },
    health: async (version) => running === version && options.healthy !== false,
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
    admission: () => admission,
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
  const world = machine({ healthy: false });
  const result = await swapSpade("0.5.0", "now", world.ports);
  expect(result.kind === "failed" && result.error).toMatch(/0.4.0 is running again/);
  expect(world.log.slice(-3)).toEqual(["restart", "flip 0.4.0", "restart"]);
  expect(world.current()).toBe("0.4.0");
  expect(world.running()).toBe("0.4.0");
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
