import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProcessInventory } from "./process-inventory.ts";
import type { ProcessIdentity } from "./process-identity.ts";

test.each(["pid", "start", "uid", "group", "missing", "unreadable"] as const)(
  "orphan recovery never kills a %s identity mismatch",
  (kind) => {
    const home = mkdtempSync(join(tmpdir(), "ace-inventory-identity-"));
    const processes = new Map<number, ProcessIdentity>([
      [10, { pid: 10, start: "owner-start", uid: 1000, group: 10 }],
      [20, { pid: 20, start: "child-start", uid: 1000, group: 20 }],
    ]);
    const killed: number[] = [];
    let unreadable = false;
    const inventory = new ProcessInventory(join(home, "processes.sqlite"), {
      identity(pid) {
        if (unreadable && pid === 20) throw new Error("unreadable kernel identity");
        return processes.get(pid);
      },
      alive: () => true,
      kill: (pid) => {
        killed.push(pid);
      },
      ownerPid: 10,
      now: () => 1,
    });
    try {
      inventory.add(20, { name: "synthetic" });
      processes.delete(10);
      const current = processes.get(20);
      if (!current) throw new Error("Missing fixture process");
      if (kind === "pid") processes.set(20, { ...current, pid: 21 });
      else if (kind === "start") processes.set(20, { ...current, start: "recycled" });
      else if (kind === "uid") processes.set(20, { ...current, uid: 1001 });
      else if (kind === "group") processes.set(20, { ...current, group: 21 });
      else if (kind === "missing") processes.delete(20);
      else unreadable = true;
      expect(() => inventory.recover()).toThrow();
      expect(killed).toEqual([]);
      expect(inventory.list()).toHaveLength(1);
    } finally {
      inventory.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("recovery keeps a live owner and kills only a verified orphan identity", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-inventory-owner-"));
  const processes = new Map<number, ProcessIdentity>([
    [10, { pid: 10, start: "owner-start", uid: 1000, group: 10 }],
    [20, { pid: 20, start: "child-start", uid: 1000, group: 20 }],
  ]);
  const killed: number[] = [];
  const inventory = new ProcessInventory(join(home, "processes.sqlite"), {
    identity: (pid) => processes.get(pid),
    alive: () => true,
    kill: (pid) => {
      killed.push(pid);
    },
    ownerPid: 10,
    now: () => 1,
  });
  try {
    inventory.add(20, { name: "synthetic" });
    expect(inventory.recover()).toEqual({ killed: 0, removed: 0 });
    expect(killed).toEqual([]);
    processes.delete(10);
    expect(inventory.recover()).toEqual({ killed: 1, removed: 0 });
    expect(killed).toEqual([20]);
  } finally {
    inventory.close();
    rmSync(home, { recursive: true, force: true });
  }
});
