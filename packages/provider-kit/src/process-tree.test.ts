import { expect, test } from "vitest";
import {
  captureDescendants,
  parseProcessParents,
  stopMembers,
  type TreeIo,
} from "./process-tree.ts";

/** A process table the test edits: pid → { parent, start }, with signals that end processes. */
function machine(
  rows: Record<number, { parent: number; start: string; ignores?: "TERM" | "all" }>,
) {
  const table = new Map(Object.entries(rows).map(([pid, row]) => [Number(pid), row]));
  const signals: string[] = [];
  const io: TreeIo = {
    platform: "darwin",
    table: () => [...table].map(([pid, row]) => `${pid} ${row.parent}`).join("\n"),
    identity: (pid) => table.get(pid)?.start,
    signal(pid, signal) {
      signals.push(`${signal} ${pid}`);
      const row = table.get(pid);
      if (!row || row.ignores === "all" || (row.ignores === "TERM" && signal === "SIGTERM")) return;
      table.delete(pid);
    },
    wait: async () => {},
  };
  return { io, table, signals };
}

test("process parents survive malformed rows", () => {
  expect([...parseProcessParents("    1     0\n  326     1\n garbage\n  400   326\n")]).toEqual([
    [1, 0],
    [326, 1],
    [400, 326],
  ]);
});

test("a tree includes grandchildren, wherever their process group is, and nothing else", () => {
  const { io } = machine({
    1: { parent: 0, start: "init" },
    100: { parent: 1, start: "daemon" },
    200: { parent: 100, start: "app-server" },
    // Started by the app-server in a session of its own: no group signal reaches it.
    300: { parent: 200, start: "detached" },
    301: { parent: 300, start: "detached-child" },
    // Another home's daemon and its child.
    900: { parent: 1, start: "other-daemon" },
    901: { parent: 900, start: "other-child" },
  });
  expect(captureDescendants([100], io)).toEqual([
    { pid: 200, start: "app-server" },
    { pid: 300, start: "detached" },
    { pid: 301, start: "detached-child" },
  ]);
});

test("trees are not read by parent pid on Windows, whose jobs contain them", () => {
  const { io } = machine({ 100: { parent: 1, start: "a" }, 200: { parent: 100, start: "b" } });
  expect(captureDescendants([100], { ...io, platform: "win32" })).toEqual([]);
});

test("a stop never signals a pid that another process holds by then", async () => {
  const { io, table, signals } = machine({
    200: { parent: 1, start: "captured" },
    300: { parent: 1, start: "captured-too" },
  });
  const members = captureDescendants([1], io);
  // 300 exited and its pid went to an unrelated process.
  table.set(300, { parent: 1, start: "someone-else" });
  expect(await stopMembers(members, 500, io)).toEqual([]);
  expect(signals).toEqual(["SIGTERM 200"]);
  expect(table.has(300)).toBe(true);
});

test("a member that ignores SIGTERM is killed, and one that outlives SIGKILL is reported", async () => {
  const { io, signals } = machine({
    200: { parent: 1, start: "stubborn", ignores: "TERM" },
    300: { parent: 1, start: "unkillable", ignores: "all" },
  });
  expect(await stopMembers(captureDescendants([1], io), 500, io)).toEqual([
    { pid: 300, start: "unkillable" },
  ]);
  expect(signals).toEqual(["SIGTERM 200", "SIGTERM 300", "SIGKILL 200", "SIGKILL 300"]);
});
