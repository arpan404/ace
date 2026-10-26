/**
 * Sidebar index scaling: a full rebuild, and one live update plus a 20-row window read, at
 * 400, 5k and 50k threads, 40 of them live. Rows arrive in time order, as a table scan returns them, which
 * is the worst case for keeping a sorted array. Pure in-memory work: no database, no
 * sockets, no provider requests.
 *
 *   node --expose-gc apps/daemon/bench/sidebar-index.ts
 *
 * Each rebuild starts after a collection, so the last run's garbage is not billed to it.
 */
import { performance } from "node:perf_hooks";
import { SidebarIndex, type SidebarFacts } from "../src/sidebar-index.ts";

const sizes = [400, 5_000, 50_000];
const workspaces = Array.from({ length: 20 }, (_, index) => `workspace-${index}`);

function facts(index: number, overrides: Partial<SidebarFacts> = {}): SidebarFacts {
  return {
    id: `thread-${String(index).padStart(6, "0")}`,
    revision: index + 1,
    workspace: workspaces[index % workspaces.length] ?? null,
    deleted: false,
    archived: index % 17 === 0,
    // History is settled; 40 threads are live, as on a busy machine.
    settled: !(index < 400 && index % 10 === 0),
    counted: true,
    activity: 1_000 + index,
    archivedAt: index % 17 === 0 ? 1_000 + index : null,
    ...overrides,
  };
}
function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function rebuild(index: SidebarIndex, all: SidebarFacts[]): void {
  index.load(all);
}

const results = sizes.map((size) => {
  const all = Array.from({ length: size }, (_, index) => facts(index));
  const index = new SidebarIndex();
  const rebuilds: number[] = [];
  for (let run = 0; run < 9; run++) {
    (globalThis as { gc?: () => void }).gc?.();
    const start = performance.now();
    rebuild(index, all);
    rebuilds.push(performance.now() - start);
  }
  // A new thread settles as the newest, and an old live one settles into history.
  const updates: number[] = [];
  const reads: number[] = [];
  for (let run = 0; run < 400; run++) {
    const fresh = facts(size + run, { revision: size * 2 + run });
    const old = facts((run % 40) * 10, { revision: size * 3 + run, settled: run % 2 === 0 });
    let start = performance.now();
    index.put(fresh);
    index.put(old);
    updates.push(performance.now() - start);
    start = performance.now();
    index.window({}, 20);
    index.window({ project: workspaces[3] }, 20);
    reads.push(performance.now() - start);
  }
  return {
    threads: size,
    "rebuild min (ms)": Number(Math.min(...rebuilds).toFixed(2)),
    "rebuild median (ms)": Number(median(rebuilds).toFixed(2)),
    "two puts (µs)": Number((median(updates) * 1000).toFixed(1)),
    "two windows (µs)": Number((median(reads) * 1000).toFixed(1)),
  };
});
console.table(results);
