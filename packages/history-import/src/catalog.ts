import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { HistoryListRequest, HistoryListResponse, HistorySession } from "@ace/protocol/history";
import { z } from "zod";

export const Source = z.object({
  summary: HistorySession,
  path: z.string(),
  fingerprint: z.string(),
  kind: z.enum(["jsonl", "database", "storage"]),
  instanceId: z.string(),
});
export type Source = z.infer<typeof Source>;
export class Catalog {
  db: DatabaseSync;
  readonly scratchRoot: string;
  private statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.scratchRoot = dirname(path);
    this.db = new DatabaseSync(path);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,instance TEXT NOT NULL,path TEXT NOT NULL,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,cwd TEXT NOT NULL,activity INTEGER NOT NULL,native TEXT NOT NULL,parent TEXT,summary TEXT NOT NULL,epoch INTEGER NOT NULL,own_activity INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS source_path ON sources(instance,path);
      CREATE INDEX IF NOT EXISTS source_workspace ON sources(cwd,activity DESC,id DESC);
      CREATE INDEX IF NOT EXISTS source_native ON sources(instance,native);
      CREATE INDEX IF NOT EXISTS source_parent ON sources(instance,parent);
      CREATE TABLE IF NOT EXISTS scans(instance TEXT PRIMARY KEY,epoch INTEGER NOT NULL);`);
  }
  private statement(sql: string) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }
  start(instance: string): number {
    this.statement(
      "INSERT INTO scans VALUES (?,1) ON CONFLICT(instance) DO UPDATE SET epoch = epoch+1",
    ).run(instance);
    return Number(this.statement("SELECT epoch FROM scans WHERE instance=?").get(instance)?.epoch);
  }
  touch(instance: string, path: string, fingerprint: string, epoch: number): boolean {
    const result = this.statement(
      "UPDATE sources SET epoch=? WHERE instance=? AND path=? AND fingerprint=?",
    ).run(epoch, instance, path, fingerprint);
    return Number(result.changes) > 0;
  }
  put(source: Source, epoch: number): void {
    const s = source.summary;
    this.statement(
      "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,cwd=excluded.cwd,activity=excluded.activity,parent=excluded.parent,summary=excluded.summary,epoch=excluded.epoch,own_activity=excluded.own_activity",
    ).run(
      s.id,
      source.instanceId,
      source.path,
      source.fingerprint,
      source.kind,
      s.cwd,
      s.lastActivity,
      s.nativeId,
      s.parentNativeId ?? null,
      JSON.stringify(s),
      epoch,
      s.lastActivity,
    );
  }
  updateCount(id: string, count: number, accuracy: "exact" | "sampled"): void {
    const source = this.get(id);
    if (!source) return;
    source.summary.messageCount = count;
    source.summary.countAccuracy = accuracy;
    this.statement("UPDATE sources SET summary=? WHERE id=?").run(
      JSON.stringify(source.summary),
      id,
    );
  }
  preservePath(instance: string, path: string, epoch: number): void {
    this.statement("UPDATE sources SET epoch=? WHERE instance=? AND path=?").run(
      epoch,
      instance,
      path,
    );
  }
  summarizeTree(instance: string): void {
    this.statement("UPDATE sources SET activity=own_activity WHERE instance=?").run(instance);
    for (let depth = 0; depth < 16; depth++) {
      const result = this.statement(
        "UPDATE sources AS parent SET activity=MAX(own_activity,COALESCE((SELECT MAX(child.activity) FROM sources child WHERE child.instance=parent.instance AND child.parent=parent.native),own_activity)) WHERE instance=? AND activity<>MAX(own_activity,COALESCE((SELECT MAX(child.activity) FROM sources child WHERE child.instance=parent.instance AND child.parent=parent.native),own_activity))",
      ).run(instance);
      if (Number(result.changes) === 0) break;
    }
    this.statement(
      "UPDATE sources SET summary=json_set(summary,'$.lastActivity',activity) WHERE instance=?",
    ).run(instance);
  }
  prune(instance: string, epoch: number): void {
    this.statement("DELETE FROM sources WHERE instance=? AND epoch<>?").run(instance, epoch);
  }
  get(id: string): Source | undefined {
    const row = this.statement("SELECT * FROM sources WHERE id=?").get(id);
    return row
      ? Source.parse({
          summary: JSON.parse(String(row.summary)),
          path: row.path,
          fingerprint: row.fingerprint,
          kind: row.kind,
          instanceId: row.instance,
        })
      : undefined;
  }
  list(input: z.infer<typeof HistoryListRequest>) {
    const { cwd, limit, before } = HistoryListRequest.parse(input);
    const rows = before
      ? this.statement(
          "SELECT summary FROM sources WHERE cwd=? AND (activity<? OR (activity=? AND id<?)) ORDER BY activity DESC,id DESC LIMIT ?",
        ).all(cwd, before.lastActivity, before.lastActivity, before.id, limit + 1)
      : this.statement(
          "SELECT summary FROM sources WHERE cwd=? ORDER BY activity DESC,id DESC LIMIT ?",
        ).all(cwd, limit + 1);
    const sessions = rows
      .slice(0, limit)
      .map((r) => HistorySession.parse(JSON.parse(String(r.summary))));
    const last = sessions.at(-1);
    return HistoryListResponse.parse({
      type: "history.list",
      sessions,
      next: rows.length > limit && last ? { lastActivity: last.lastActivity, id: last.id } : null,
    });
  }
  children(instance: string, native: string): Source[] {
    return this.statement("SELECT id FROM sources WHERE instance=? AND parent=? LIMIT 513")
      .all(instance, native)
      .map((r) => this.get(String(r.id)))
      .filter((s): s is Source => s !== undefined);
  }
  hasNative(instance: string, native: string): boolean {
    return Boolean(
      this.statement(
        "SELECT id FROM sources WHERE instance=? AND native=? AND kind='jsonl' LIMIT 1",
      ).get(instance, native),
    );
  }
  close(): void {
    this.db.close();
  }
}
