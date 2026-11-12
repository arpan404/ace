import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Thread } from "@ace/protocol";
import { openSidebarColumns, repairSidebarColumns } from "../src/sidebar-columns.ts";
import { SidebarLive } from "../src/sidebar-live.ts";
import { sidebarPageStorage } from "../src/sidebar-page-storage.ts";
import { decodeThreadRow } from "../src/thread-row.ts";
import { confirmThreadRows } from "../src/thread-row-trust.ts";

/**
 * What a cold sidebar page costs with its facts evaluated from threads JSON (before) and read
 * from sidebar_thread_columns (after), per scope, plus the live index's full rebuild, the table's
 * backfill at open and what its triggers add to a thread write:
 *
 *   bun apps/daemon/bench/sidebar-columns.ts /tmp/ace-clone/events.sqlite
 *
 * Page reads use the copy read-only, with the table in the temp schema. Write timings use an
 * APFS clone (`cp -c`) in a temp directory, deleted after.
 */
const path = process.argv[2];
if (!path) throw new Error("usage: sidebar-columns.ts <events.sqlite copy> [page size]");
const pageSize = Number(process.argv[3] ?? 50);
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
function cpu(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}
const round = (n: number) => +n.toFixed(2);

const db = new DatabaseSync(path, { readOnly: true });
// Rows confirmed as this build's writer leaves them (thread-row-trust.ts), in the temp schema.
db.exec(
  "CREATE TEMP TABLE thread_row_trust (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, canonical INTEGER NOT NULL)",
);
confirmThreadRows(db, -1);
const backfillMs = cpu(() => openSidebarColumns(db, "temp"));
const statement = (sql: string) => db.prepare(sql);
// A row the facts can't be read from sends every read back to the JSON expressions.
const before = () =>
  db.exec(
    "INSERT INTO temp.sidebar_thread_columns(thread_id, revision, readable) VALUES ('~bench', 0, 0)",
  );
const after = () => db.exec("DELETE FROM temp.sidebar_thread_columns WHERE thread_id = '~bench'");
// Payload decode is the same either way; "sql only" leaves it out to show the queries alone.
const skipDecode = (row: Record<string, unknown>) => ({ id: String(row.id) }) as Thread;
const projects = db
  .prepare(
    "SELECT workspace_id AS id FROM threads GROUP BY workspace_id ORDER BY COUNT(*) DESC, id",
  )
  .all()
  .map((row) => String(row.id));
const scopes: { name: string; options: { project?: string; archived?: boolean } }[] = [
  { name: "inbox", options: {} },
  { name: "archived", options: { archived: true } },
  // The three projects with the most threads.
  ...projects.slice(0, 3).map((project, i) => ({ name: `project${i}`, options: { project } })),
];
const pages: Record<string, { beforeMs: number; afterMs: number; entries: number }> = {};
for (const scope of scopes) {
  const read = (full: boolean) => () =>
    sidebarPageStorage(statement, full ? decodeThreadRow : skipDecode, {
      limit: pageSize,
      ...scope.options,
    });
  const sample = (full: boolean) => {
    const runs = { before: [] as number[], after: [] as number[] };
    for (let run = 0; run < 15; run++) {
      before();
      runs.before.push(cpu(read(full)));
      after();
      runs.after.push(cpu(read(full)));
    }
    return runs;
  };
  const full = sample(true);
  const sql = sample(false);
  const entries = read(true)().threads.length;
  pages[scope.name] = {
    beforeMs: round(median(full.before)),
    afterMs: round(median(full.after)),
    entries,
  };
  pages[`${scope.name} (sql only)`] = {
    beforeMs: round(median(sql.before)),
    afterMs: round(median(sql.after)),
    entries,
  };
}
const rebuild = { before: [] as number[], after: [] as number[] };
for (let run = 0; run < 15; run++) {
  before();
  rebuild.before.push(cpu(() => new SidebarLive(statement).sync()));
  after();
  rebuild.after.push(cpu(() => new SidebarLive(statement).sync()));
}
const rows = Number(db.prepare("SELECT COUNT(*) AS n FROM threads").get()?.n);
db.close();

// Writes: the same updates on a clone, with and without the table's triggers.
const home = mkdtempSync(join(tmpdir(), "ace-sidebar-columns-"));
const writes = { before: 0, after: 0, repairMs: 0 };
try {
  const copy = join(home, "events.sqlite");
  execFileSync("cp", ["-c", path, copy]);
  execFileSync("cp", ["-c", `${path}-wal`, `${copy}-wal`]);
  const rw = new DatabaseSync(copy);
  rw.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
  openSidebarColumns(rw);
  rw.exec("DELETE FROM sidebar_thread_columns");
  writes.repairMs = round(cpu(() => repairSidebarColumns(rw)));
  const ids = rw
    .prepare("SELECT id FROM threads ORDER BY updated_at DESC LIMIT 200")
    .all()
    .map((row) => String(row.id));
  const update = rw.prepare("UPDATE threads SET updated_at = updated_at + 1 WHERE id = ?");
  const run = () => {
    rw.exec("BEGIN");
    for (let i = 0; i < 10; i++) for (const id of ids) update.run(id);
    rw.exec("COMMIT");
  };
  const per = (ms: number) => round((ms * 1000) / (ids.length * 10));
  run();
  writes.after = per(median(Array.from({ length: 5 }, () => cpu(run))));
  rw.exec("DROP TRIGGER sidebar_columns_insert; DROP TRIGGER sidebar_columns_delete");
  run();
  writes.before = per(median(Array.from({ length: 5 }, () => cpu(run))));
  rw.close();
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      threads: rows,
      backfillCpuMs: round(backfillMs),
      repairAllCpuMs: writes.repairMs,
      pageCpuMs: pages,
      liveRebuildCpuMs: {
        before: round(median(rebuild.before)),
        after: round(median(rebuild.after)),
      },
      threadUpdateCpuUs: { before: writes.before, after: writes.after },
    },
    null,
    2,
  ),
);
