import { DatabaseSync } from "node:sqlite";
import type { EntityCollection, Thread, ThreadId } from "@ace/protocol";
import { StatusStore } from "../src/status-store.ts";
import { ThreadReads } from "../src/thread-reads.ts";
import { decodeThreadRow } from "../src/thread-row.ts";

/**
 * CPU per entity page and per thread status snapshot, read from a database copy (read-only):
 *
 *   bun apps/daemon/bench/entity-pages.ts /tmp/ace-clone/events.sqlite [threads]
 *
 * Runs through `ThreadReads.readEntityPage` and `StatusStore.snapshot`, the paths a client's
 * `entities.page` request and thread subscription take. With `--compare`, each round also reads
 * with entity rows untrusted (decoded with their schemas, as rows an older build wrote are),
 * interleaved with trusted reads.
 */
const path = process.argv[2];
if (!path) throw new Error("usage: entity-pages.ts <events.sqlite copy> [threads] [--compare]");
const threadCount = Number(process.argv[3] ?? 8);
const compare = process.argv.includes("--compare");
const db = new DatabaseSync(path, { readOnly: true });
const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
const statement = (sql: string) => {
  let prepared = statements.get(sql);
  if (!prepared) statements.set(sql, (prepared = db.prepare(sql)));
  return prepared;
};
const threads = new Map<string, Thread>();
const getThread = (id: ThreadId): Thread | undefined => {
  let thread = threads.get(id);
  if (!thread) {
    const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
    if (!row) return undefined;
    threads.set(id, (thread = decodeThreadRow(row)));
  }
  return thread;
};
const trust = { trusted: true };
const status = new StatusStore(db, statement, trust);
status.initialize(getThread);
const head = Number(db.prepare("SELECT MAX(seq) AS head FROM events").get()?.head ?? 0);
const reads = new ThreadReads({
  db,
  cache: { read: <T>(_key: string, load: () => T) => load() } as never,
  payloads: undefined as never,
  history: undefined as never,
  status,
  flush: () => {},
  headSeq: () => head,
  getThread,
  readThread: getThread,
  inTransaction: () => true,
  report: (error) => console.error(error),
});
const busiest = db
  .prepare(
    "SELECT thread_id, COUNT(*) AS n FROM view_entities e JOIN threads t ON t.id = e.thread_id GROUP BY thread_id ORDER BY n DESC LIMIT ?",
  )
  .all(threadCount)
  .map((row) => String(row.thread_id) as ThreadId);
const collections: EntityCollection[] = ["agents", "runs", "interactions", "backgroundTasks"];
let entries = 0;
function pages(): number {
  let count = 0;
  for (const id of busiest)
    for (const collection of collections) {
      const page = reads.readEntityPage(id, collection, Number.MAX_SAFE_INTEGER, 200);
      entries += page.entries.length;
      count++;
    }
  return count;
}
function snapshots(): number {
  for (const id of busiest) status.snapshot(getThread(id), head);
  return busiest.length;
}
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
function cpuPerOp(run: () => number): number {
  const before = process.cpuUsage();
  const ops = run();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / ops;
}
const modes = compare ? ([true, false] as const) : ([true] as const);
const results: Record<string, { page: number[]; snapshot: number[] }> = {};
for (const mode of modes) results[String(mode)] = { page: [], snapshot: [] };
pages();
snapshots();
for (let round = 0; round < 15; round++)
  for (const mode of modes) {
    trust.trusted = mode;
    const result = results[String(mode)]!;
    result.page.push(cpuPerOp(pages));
    result.snapshot.push(cpuPerOp(snapshots));
  }
console.log(
  JSON.stringify(
    {
      threads: busiest.length,
      entriesPerPage: +(
        entries /
        (busiest.length * collections.length * (15 * modes.length + 1))
      ).toFixed(1),
      ...Object.fromEntries(
        Object.entries(results).map(([mode, r]) => [
          mode === "true" ? "trusted" : "decoded",
          { pageCpuUs: +median(r.page).toFixed(0), snapshotCpuUs: +median(r.snapshot).toFixed(0) },
        ]),
      ),
    },
    null,
    2,
  ),
);
