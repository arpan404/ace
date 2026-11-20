import type { ProcessListing } from "./process-listing.ts";
import type { PidFds } from "./process-signal.ts";
import type { TreeIo } from "./process-tree.ts";

/** One process in a fake machine. */
export type FakeProcess = {
  parent: number;
  start: string;
  /** Defaults to the parent's group, as a fork's is. */
  group?: number;
  env?: string[];
  argv?: string[];
  ignores?: "TERM" | "all";
  zombie?: boolean;
};

/** Moments a test can change the machine at, to race the code under test. */
export type FakeHooks = {
  /** Before a process's identity is read. */
  beforeIdentity?(pid: number): void;
  /** After kill(2) or a pidfd signal reached a process. */
  afterSignal?(pid: number, signal: NodeJS.Signals): void;
  /** After a pidfd was opened for a pid. */
  afterOpen?(pid: number): void;
};

/**
 * A process table tests edit, behind the tree and listing seams. Signals end processes (those
 * that don't ignore them); an ended process's children go to init, as on macOS. `signals`
 * names each signal's target as `SIGNAL pid:start`, so a test sees which process it reached.
 */
export function fakeMachine(rows: Record<number, FakeProcess>, hooks: FakeHooks = {}) {
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
  /** Deliver `signal` to the process holding `pid` now. */
  const deliver = (pid: number, signal: NodeJS.Signals) => {
    const row = table.get(pid);
    if (!row) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    signals.push(`${signal} ${pid}:${row.start}`);
    if (row.ignores !== "all" && !(row.ignores === "TERM" && signal === "SIGTERM")) end(pid);
    hooks.afterSignal?.(pid, signal);
  };
  const children = (pid: number) =>
    [...table].filter(([, row]) => row.parent === pid).map(([child]) => child);
  const tree: TreeIo = {
    platform: "darwin",
    lister: () => children,
    identity(pid) {
      hooks.beforeIdentity?.(pid);
      const row = table.get(pid);
      return row && !row.zombie
        ? { start: row.start, parent: row.parent, group: groupOf(pid) }
        : undefined;
    },
    kill: deliver,
    wait: async () => {},
  };
  /** Linux pidfds: a descriptor pins the process that held the pid when it was opened. */
  const pinned = new Map<number, { pid: number; start: string }>();
  let next = 3;
  const pidfd: PidFds = {
    open(pid) {
      const row = table.get(pid);
      if (!row) return undefined;
      const fd = next++;
      pinned.set(fd, { pid, start: row.start });
      hooks.afterOpen?.(pid);
      return fd;
    },
    send(fd, signal) {
      const target = pinned.get(fd);
      if (!target || table.get(target.pid)?.start !== target.start) return false;
      deliver(target.pid, signal);
      return true;
    },
    close: (fd) => void pinned.delete(fd),
  };
  const listing: ProcessListing = {
    platform: "darwin",
    lister: () => children,
    all: () => [...table.keys()],
    info(pid) {
      const row = table.get(pid);
      return (
        row && { start: row.start, parent: row.parent, group: groupOf(pid), zombie: !!row.zombie }
      );
    },
    environment: (pid) => table.get(pid)?.env,
    arguments: (pid) => table.get(pid)?.argv,
  };
  return { tree, listing, table, signals, end, pidfd };
}
