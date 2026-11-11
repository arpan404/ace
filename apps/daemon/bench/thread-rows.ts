import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { createDevThread } from "../src/commands.ts";
import { Store } from "../src/store.ts";
import { sidebarPageStorage } from "../src/sidebar-page-storage.ts";
import { confirmThreadRows } from "../src/thread-row-trust.ts";
import {
  confirmThreadRow,
  decodeThreadRow,
  threadRowColumns,
  threadRowSource,
} from "../src/thread-row.ts";

/**
 * What decoding threads rows costs validated against reading rows this build confirmed as
 * stored (ADR 0125, `thread-row-trust.ts`). Read-only against a database copy; the stamp
 * table is a temporary one, so the copy is never written:
 *
 *   bun apps/daemon/bench/thread-rows.ts /tmp/ace-clone/events.sqlite
 *
 * Reports how many rows confirm (read the same as stored as validated), what confirming them
 * all costs and what one open's capped pass costs, CPU per row decoded, and CPU per sidebar page read with
 * a cold thread cache (every entry decoded), before and after the stamps.
 */
const path = process.argv[2];
if (!path) throw new Error("usage: thread-rows.ts <events.sqlite copy> [page size]");
const pageSize = Number(process.argv[3] ?? 50);
const db = new DatabaseSync(path, { readOnly: true });
db.exec(
  "CREATE TEMP TABLE thread_row_trust (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, canonical INTEGER NOT NULL)",
);
type Row = Record<string, SQLOutputValue>;
const rows = db.prepare(`SELECT ${threadRowColumns} FROM ${threadRowSource}`).all() as Row[];
let bytes = 0;
for (const row of rows)
  for (const value of Object.values(row)) bytes += typeof value === "string" ? value.length : 8;

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
function cpu(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

// Open-time confirmation after an upgrade: every row checked once.
const confirmMs = median(
  Array.from({ length: 5 }, () => {
    db.exec("DELETE FROM thread_row_trust");
    return cpu(() => confirmThreadRows(db, -1));
  }),
);
const perOpenMs = median(
  Array.from({ length: 5 }, () => {
    db.exec("DELETE FROM thread_row_trust");
    return cpu(() => confirmThreadRows(db));
  }),
);
confirmThreadRows(db, -1);
const confirmed = Number(
  db.prepare("SELECT COUNT(*) AS n FROM thread_row_trust WHERE canonical = 1").get()?.n,
);
// Which parts keep a row from confirming, by the first differing top-level field.
const differing = new Map<string, number>();
for (const row of rows) {
  const { thread, canonical } = confirmThreadRow(row);
  if (canonical) continue;
  const trusted = decodeThreadRow({ ...row, row_trusted: 1 });
  const keys = new Set([...Object.keys(thread), ...Object.keys(trusted)]);
  const field =
    [...keys].find(
      (key) =>
        JSON.stringify(Reflect.get(thread, key)) !== JSON.stringify(Reflect.get(trusted, key)),
    ) ?? "(field order)";
  differing.set(field, (differing.get(field) ?? 0) + 1);
}

const stamps = new Map(
  (db.prepare("SELECT thread_id, canonical FROM thread_row_trust").all() as Row[]).map((row) => [
    String(row.thread_id),
    row.canonical,
  ]),
);
const unstamped = rows.map((row) => ({ ...row, row_trusted: null }));
const stamped = rows.map((row) => ({ ...row, row_trusted: stamps.get(String(row.id)) ?? null }));
const decodeAll = (input: Row[]) => () => {
  for (const row of input) decodeThreadRow(row);
};
const snapshot = new Map<string, number>();
const restore = () => {
  db.exec("DELETE FROM thread_row_trust");
  const insert = db.prepare("INSERT INTO thread_row_trust VALUES (?, ?, ?)");
  for (const [id, row] of snapshot) insert.run(id, row, 1);
};
for (const row of db
  .prepare("SELECT thread_id, revision FROM thread_row_trust WHERE canonical = 1")
  .all() as Row[])
  snapshot.set(String(row.thread_id), Number(row.revision));
const statement = (sql: string) => db.prepare(sql);
const sidebar = () =>
  sidebarPageStorage(statement, (row) => decodeThreadRow(row), { limit: pageSize });

const runs = { rowsBefore: [] as number[], rowsAfter: [] as number[] };
const pages = { before: [] as number[], after: [] as number[] };
decodeAll(unstamped)();
decodeAll(stamped)();
for (let round = 0; round < 15; round++) {
  runs.rowsBefore.push(cpu(decodeAll(unstamped)));
  runs.rowsAfter.push(cpu(decodeAll(stamped)));
  db.exec("DELETE FROM thread_row_trust");
  pages.before.push(cpu(sidebar));
  restore();
  pages.after.push(cpu(sidebar));
}
const page = sidebar();

// Repeated getThread on one unchanged thread: a cache hit, so no decode at all.
const home = mkdtempSync(join(tmpdir(), "ace-thread-rows-"));
const store = new Store(join(home, "events.sqlite"));
const devThread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
const calls = 20_000;
const getThreadMs = median(
  Array.from({ length: 5 }, () =>
    cpu(() => {
      for (let call = 0; call < calls; call++) store.getThread(devThread.id);
    }),
  ),
);
const readThreadMs = median(
  Array.from({ length: 5 }, () =>
    cpu(() => {
      for (let call = 0; call < calls; call++) store.readThread(devThread.id);
    }),
  ),
);
store.close();
rmSync(home, { recursive: true, force: true });
const before = median(runs.rowsBefore);
const after = median(runs.rowsAfter);
const pageBefore = median(pages.before);
const pageAfter = median(pages.after);
console.log(
  JSON.stringify(
    {
      rows: rows.length,
      storedMiB: +(bytes / 1048576).toFixed(1),
      rowsConfirmed: confirmed,
      notConfirmedBy: Object.fromEntries(differing),
      confirmAllCpuMs: +confirmMs.toFixed(1),
      confirmOneOpenCpuMs: +perOpenMs.toFixed(1),
      decodeUsPerRowBefore: +((before * 1000) / rows.length).toFixed(1),
      decodeUsPerRowAfter: +((after * 1000) / rows.length).toFixed(1),
      decodeSpeedup: +(before / after).toFixed(1),
      sidebarEntries: page.threads.length,
      sidebarPageCpuMsBefore: +pageBefore.toFixed(2),
      sidebarPageCpuMsAfter: +pageAfter.toFixed(2),
      sidebarSpeedup: +(pageBefore / pageAfter).toFixed(1),
      getThreadHitUs: +((getThreadMs * 1000) / calls).toFixed(2),
      readThreadHitUs: +((readThreadMs * 1000) / calls).toFixed(2),
    },
    null,
    2,
  ),
);
