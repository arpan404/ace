import { existsSync } from "node:fs";
import { z } from "zod";
import type { KeptJournal } from "./process-marker.ts";
import { memberOf, type TreeMember } from "./process-tree.ts";
import type { WatchJournal } from "./process-watch.ts";
import { DatabaseSync } from "./sqlite.ts";

/*
 * Beside the process inventory, by pid and kernel start:
 * - escapees: processes a daemon run saw leave the groups it owns (another session, or an
 *   orphan whose parent exited). A group kill at the next start never reaches them; this lets
 *   that start, and `ace stop`, stop exactly those processes and nothing that reused a pid;
 * - kept: processes ace launched on purpose to outlive it (the updater, an editor, a browser),
 *   which no sweep may signal.
 * Rows hold kernel identities and a run id only.
 */

const Row = z.object({ pid: z.number().int().positive(), start: z.string(), run: z.string() });
export type EscapeeRow = z.infer<typeof Row>;
const Member = z.object({ pid: z.number().int().positive(), start: z.string() });

const rowLimit = 4_096;
const schema = [
  "CREATE TABLE IF NOT EXISTS escapees(pid INTEGER NOT NULL,start TEXT NOT NULL,run TEXT NOT NULL,PRIMARY KEY(pid,start))",
  "CREATE TABLE IF NOT EXISTS kept(pid INTEGER NOT NULL,start TEXT NOT NULL,PRIMARY KEY(pid,start))",
];

export class EscapeeJournal implements WatchJournal, KeptJournal {
  private readonly db: DatabaseSync;
  private readonly run: string;
  private readonly identify: (pid: number) => TreeMember | undefined;
  constructor(
    path: string,
    run: string,
    identify: (pid: number) => TreeMember | undefined = (pid) => memberOf(pid),
  ) {
    this.run = run;
    this.identify = identify;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    for (const statement of schema) this.db.exec(statement);
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
  keep(pid: number): void {
    const member = this.identify(pid);
    if (!member) return;
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM kept").get()?.n);
    // Spent rows (processes long gone) are dropped first, so the table never fills with them.
    if (count >= rowLimit) {
      for (const row of this.kept()) if (!this.identify(row.pid)) this.unkeep(row);
    }
    this.db
      .prepare("INSERT INTO kept VALUES (?,?) ON CONFLICT(pid,start) DO NOTHING")
      .run(member.pid, member.start);
  }
  kept(): TreeMember[] {
    return this.db
      .prepare("SELECT pid,start FROM kept ORDER BY pid")
      .all()
      .map((row) => Member.parse(row));
  }
  private unkeep(member: TreeMember): void {
    this.db.prepare("DELETE FROM kept WHERE pid=? AND start=?").run(member.pid, member.start);
  }
  close(): void {
    this.db.close();
  }
}

/** Read-only, for `ace stop`: a run's escapees, and every process kept to outlive ace. */
export function readOwnership(
  path: string,
  run: string | undefined,
): { escapees: TreeMember[]; kept: TreeMember[] } {
  if (!existsSync(path)) return { escapees: [], kept: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const has = (table: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !==
      undefined;
    const escapees =
      run && has("escapees")
        ? db
            .prepare("SELECT pid,start FROM escapees WHERE run=? ORDER BY pid")
            .all(run)
            .map((row) => Member.parse(row))
        : [];
    const kept = has("kept")
      ? db
          .prepare("SELECT pid,start FROM kept ORDER BY pid")
          .all()
          .map((row) => Member.parse(row))
      : [];
    return { escapees, kept };
  } finally {
    db.close();
  }
}
