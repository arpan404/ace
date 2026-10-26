import type { SQLOutputValue } from "node:sqlite";
import { expect, test } from "vitest";
import { ThreadCache } from "./thread-cache.ts";
import { decodeThreadRow } from "./thread-row.ts";

type Row = Record<string, SQLOutputValue>;

/** Small seeded generator, so a failing sequence replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const row = (id: string, details: string): Row => ({
  id,
  workspace_id: "workspace",
  title: "Task",
  provider: "codex",
  status: '{"state":"done"}',
  created_at: 1,
  updated_at: 1,
  archived_at: null,
  imported: null,
  root_agent_id: null,
  client: "{}",
  transitions: null,
  provider_metadata: null,
  acp: null,
  details: JSON.stringify({ mode: "worktree", worktree: details }),
  capabilities: null,
});

/** A threads table in memory, counting the rows the cache had to read and decode. */
function source() {
  const rows = new Map<string, { row: Row; revision: number }>();
  const reads = new Map<string, number>();
  let revision = 0;
  let writing = false;
  return {
    rows,
    reads,
    write(next: Row) {
      rows.set(String(next.id), { row: next, revision: ++revision });
      return revision;
    },
    set writing(value: boolean) {
      writing = value;
    },
    cache: (maxBytes: number) =>
      new ThreadCache(
        {
          revision: (id) => rows.get(id)?.revision,
          row: (id) => {
            reads.set(id, (reads.get(id) ?? 0) + 1);
            const stored = rows.get(id);
            return stored && { ...stored.row, row_revision: stored.revision };
          },
          committed: () => !writing,
        },
        256,
        maxBytes,
      ),
  };
}

/** The writer's path: read inside a write, write the row, keep what it now decodes to. */
function writeThrough(
  store: ReturnType<typeof source>,
  cache: ThreadCache,
  id: string,
  details: string,
) {
  store.writing = true;
  cache.begin();
  cache.read(id);
  const next = row(id, details);
  const revision = store.write(next);
  cache.remember(id, revision, decodeThreadRow(next), { details: next.details ?? null });
  cache.commit();
  cache.end();
  store.writing = false;
}

test("a cached thread that grows past the budget through its own writes is let go", () => {
  const store = source();
  const cache = store.cache(8 * 1024);
  store.write(row("grows", "small"));
  cache.read("grows");
  expect(store.reads.get("grows")).toBe(1);
  writeThrough(store, cache, "grows", "x".repeat(4000));
  const reads = store.reads.get("grows") ?? 0;
  // Too heavy to keep: the next read decodes the row again.
  expect(cache.read("grows")?.details?.worktree).toHaveLength(4000);
  expect(store.reads.get("grows")).toBe(reads + 1);
});

test("through random writes, the threads the cache serves stay within its byte budget", () => {
  const budget = 32 * 1024;
  for (const seed of [1, 2, 3]) {
    const next = random(seed);
    const store = source();
    const cache = store.cache(budget);
    const ids = Array.from({ length: 12 }, (_, n) => `t${n}`);
    for (const id of ids) store.write(row(id, "small"));
    for (let step = 0; step < 400; step++) {
      const id = ids[Math.floor(next() * ids.length)] ?? "t0";
      if (next() < 0.3) cache.read(id);
      else writeThrough(store, cache, id, "x".repeat(Math.floor(next() * 4000)));
      // Every thread served without reading its row is held; together they fit the budget.
      let held = 0;
      for (const each of ids) {
        const before = store.reads.get(each) ?? 0;
        const thread = cache.read(each);
        if ((store.reads.get(each) ?? 0) === before)
          held += (thread?.details?.worktree?.length ?? 0) * 4;
      }
      expect(held, `seed ${seed}, step ${step}`).toBeLessThanOrEqual(budget);
    }
  }
});
