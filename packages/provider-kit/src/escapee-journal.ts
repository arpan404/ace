import { z } from "zod";
import { DatabaseSync } from "./sqlite.ts";
import type { TreeMember } from "./process-tree.ts";
import type { WatchJournal } from "./process-watch.ts";

/*
 * The processes a daemon run saw leave the groups it owns (another session, or an orphan whose
 * parent exited), by pid and kernel start, beside the process inventory. A group kill at the
 * next start never reaches them; this journal lets that start stop exactly those processes and
 * nothing that reused a pid. Rows hold kernel identities and a run id only.
 */

const Row = z.object({ pid: z.number().int().positive(), start: z.string(), run: z.string() });
export type EscapeeRow = z.infer<typeof Row>;

const rowLimit = 4_096;

export class EscapeeJournal implements WatchJournal {
  private readonly db: DatabaseSync;
  private readonly run: string;
  constructor(path: string, run: string) {
    this.run = run;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS escapees(pid INTEGER NOT NULL,start TEXT NOT NULL,run TEXT NOT NULL,PRIMARY KEY(pid,start))",
    );
  }
  record(members: readonly TreeMember[]): void {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM escapees").get()?.n);
    const insert = this.db.prepare(
      "INSERT INTO escapees VALUES (?,?,?) ON CONFLICT(pid,start) DO UPDATE SET run=excluded.run",
    );
    for (const member of members.slice(0, Math.max(0, rowLimit - count)))
      insert.run(member.pid, member.start, this.run);
  }
  forget(members: readonly TreeMember[]): void {
    const remove = this.db.prepare("DELETE FROM escapees WHERE pid=? AND start=?");
    for (const member of members) remove.run(member.pid, member.start);
  }
  /** What earlier runs recorded and never forgot: their leftovers, if still running. */
  earlier(): EscapeeRow[] {
    return this.db
      .prepare("SELECT pid,start,run FROM escapees WHERE run<>? ORDER BY pid")
      .all(this.run)
      .map((row) => Row.parse(row));
  }
  close(): void {
    this.db.close();
  }
}
