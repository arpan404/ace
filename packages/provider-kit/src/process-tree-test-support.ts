import type { ProcessListing } from "./process-listing.ts";
import type { TreeIo } from "./process-tree.ts";

/** One process in a fake machine. */
export type FakeProcess = {
  parent: number;
  start: string;
  /** Defaults to the parent's group, as a fork's is. */
  group?: number;
  env?: string[];
  ignores?: "TERM" | "all";
  zombie?: boolean;
};

/**
 * A process table tests edit, behind the tree and listing seams. Signals end processes (those
 * that don't ignore them); an ended process's children go to init, as on macOS.
 */
export function fakeMachine(rows: Record<number, FakeProcess>) {
  const table = new Map(Object.entries(rows).map(([pid, row]) => [Number(pid), { ...row }]));
  const signals: string[] = [];
  const groupOf = (pid: number): number => {
    const row = table.get(pid);
    if (!row) return pid;
    return row.group ?? (row.parent > 1 ? groupOf(row.parent) : pid);
  };
  const end = (pid: number) => {
    table.delete(pid);
    for (const row of table.values()) if (row.parent === pid) row.parent = 1;
  };
  const tree: TreeIo = {
    platform: "darwin",
    children: (pid) => [...table].filter(([, row]) => row.parent === pid).map(([child]) => child),
    identity(pid) {
      const row = table.get(pid);
      return row && !row.zombie ? { start: row.start, group: groupOf(pid) } : undefined;
    },
    signal(pid, signal) {
      signals.push(`${signal} ${pid}`);
      const row = table.get(pid);
      if (!row || row.ignores === "all" || (row.ignores === "TERM" && signal === "SIGTERM")) return;
      end(pid);
    },
    wait: async () => {},
  };
  const listing: ProcessListing = {
    platform: "darwin",
    children: tree.children,
    all: () => [...table.keys()],
    parent: (pid) => table.get(pid)?.parent,
    environment: (pid) => table.get(pid)?.env,
    zombie: (pid) => table.get(pid)?.zombie === true,
  };
  return { tree, listing, table, signals, end };
}
