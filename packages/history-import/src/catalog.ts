import { contains } from "@ace/native-session";
import { setImmediate } from "node:timers/promises";
import type { ProviderHome } from "./contracts.ts";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { StatementSync } from "node:sqlite";
import { HistoryListRequest, HistoryListResponse, HistorySession } from "@ace/protocol/history";
import { z } from "zod";
import { ScanUpdates } from "./scan-updates.ts";

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
  private reader: DatabaseSync;
  private readStatements = new Map<string, StatementSync>();
  readonly scratchRoot: string;
  private statements = new Map<string, StatementSync>();
  readonly updates: ScanUpdates;
  private registryKey = "";
  private needsCleanup = true;
  constructor(path: string) {
    this.scratchRoot = dirname(path);
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,instance TEXT NOT NULL,path TEXT NOT NULL,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,cwd TEXT NOT NULL,activity INTEGER NOT NULL,native TEXT NOT NULL,parent TEXT,summary TEXT NOT NULL,epoch INTEGER NOT NULL,own_activity INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS source_path ON sources(instance,path);
      CREATE INDEX IF NOT EXISTS source_workspace ON sources(cwd,activity DESC,id DESC);
      CREATE INDEX IF NOT EXISTS source_native ON sources(instance,native);
      CREATE INDEX IF NOT EXISTS source_parent ON sources(instance,parent);
      CREATE TABLE IF NOT EXISTS scans(instance TEXT PRIMARY KEY,epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS files(instance TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,fingerprint TEXT NOT NULL,home TEXT NOT NULL,provider TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(instance,path));`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS catalog_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    this.updates = new ScanUpdates(this.db);
    this.reader = new DatabaseSync(path, { readOnly: true });
    this.reader.exec(
      "PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256",
    );
  }
  private readStatement(sql: string) {
    let stmt = this.readStatements.get(sql);
    if (!stmt) {
      stmt = this.reader.prepare(sql);
      this.readStatements.set(sql, stmt);
    }
    return stmt;
  }
  private statement(sql: string) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }
  /** Install bounded trust filters before serving cached rows; defer inventory cleanup. */
  reconcile(instances: ProviderHome[]): void {
    this.registryKey = JSON.stringify(
      instances
        .map((instance) => [instance.id, resolve(instance.homeDir), instance.provider])
        .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    this.needsCleanup =
      this.statement("SELECT value FROM catalog_settings WHERE key='instances'").get()?.value !==
      this.registryKey;
    for (const db of [this.db, this.reader]) {
      db.exec(
        "CREATE TEMP TABLE registered_instances(id TEXT PRIMARY KEY,home TEXT,provider TEXT)",
      );
      db.function("history_home_contains", { deterministic: true }, (home, path) =>
        typeof home === "string" && typeof path === "string" && contains(home, path) ? 1 : 0,
      );
      const insert = db.prepare("INSERT INTO registered_instances VALUES (?,?,?)");
      for (const instance of instances) {
        const home = resolve(instance.homeDir);
        insert.run(instance.id, home, instance.provider);
      }
      db.exec(`CREATE TEMP VIEW visible_sources AS SELECT sources.* FROM sources
        JOIN registered_instances r ON sources.instance=r.id
        WHERE json_extract(summary,'$.provider')=r.provider
        AND history_home_contains(r.home,path)=1`);
    }
  }
  async cleanup(signal: AbortSignal): Promise<void> {
    if (!this.needsCleanup) return;
    let after = "";
    for (;;) {
      signal.throwIfAborted();
      const rows = this.statement("SELECT id FROM sources WHERE id>? ORDER BY id LIMIT 256").all(
        after,
      );
      if (!rows.length) break;
      for (const row of rows) {
        after = z.string().parse(row.id);
        this.statement(
          "DELETE FROM sources WHERE id=? AND id NOT IN (SELECT id FROM visible_sources WHERE id=?)",
        ).run(after, after);
      }
      await setImmediate();
    }
    await this.cleanupFiles(signal);
    this.statement("INSERT OR REPLACE INTO catalog_settings VALUES ('instances',?)").run(
      this.registryKey,
    );
    this.needsCleanup = false;
  }
  private async cleanupFiles(signal: AbortSignal): Promise<void> {
    let after = 0;
    for (;;) {
      signal.throwIfAborted();
      const rows = this.statement(
        "SELECT rowid FROM files WHERE rowid>? ORDER BY rowid LIMIT 256",
      ).all(after);
      if (!rows.length) break;
      for (const row of rows) {
        after = z.number().parse(row.rowid);
        this.statement(
          "DELETE FROM files WHERE rowid=? AND NOT EXISTS (SELECT 1 FROM registered_instances r WHERE r.id=files.instance AND r.home=files.home AND r.provider=files.provider AND history_home_contains(r.home,files.path)=1)",
        ).run(after);
      }
      await setImmediate();
    }
    for (;;) {
      signal.throwIfAborted();
      const removed = this.statement(
        "DELETE FROM scans WHERE rowid IN (SELECT rowid FROM scans WHERE instance NOT IN (SELECT id FROM registered_instances) LIMIT 256)",
      ).run();
      if (!Number(removed.changes)) break;
      await setImmediate();
    }
  }
  remember(
    instance: ProviderHome,
    path: string,
    size: number,
    mtime: number,
    fingerprint: string,
    epoch: number,
  ): void {
    this.statement(
      "INSERT INTO files VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(instance,path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,fingerprint=excluded.fingerprint,home=excluded.home,provider=excluded.provider,epoch=excluded.epoch",
    ).run(
      instance.id,
      path,
      size,
      mtime,
      fingerprint,
      resolve(instance.homeDir),
      instance.provider,
      epoch,
    );
  }
  start(instance: string): number {
    this.statement(
      "INSERT INTO scans VALUES (?,1) ON CONFLICT(instance) DO UPDATE SET epoch = epoch+1",
    ).run(instance);
    return Number(this.statement("SELECT epoch FROM scans WHERE instance=?").get(instance)?.epoch);
  }
  touch(instance: string, path: string, fingerprint: string, epoch: number): boolean {
    const cached = this.statement(
      "UPDATE files SET epoch=? WHERE instance=? AND path=? AND fingerprint=? AND EXISTS (SELECT 1 FROM registered_instances r WHERE r.id=files.instance AND r.home=files.home AND r.provider=files.provider)",
    ).run(epoch, instance, path, fingerprint);
    if (Number(cached.changes) === 0) return false;
    this.statement("UPDATE sources SET epoch=? WHERE instance=? AND path=? AND fingerprint=?").run(
      epoch,
      instance,
      path,
      fingerprint,
    );
    return true;
  }
  put(source: Source, epoch: number): void {
    const s = source.summary;
    this.updates.source(source.instanceId, s.nativeId, s.parentNativeId);
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
  async summarizeTree(
    instance: string,
    signal: AbortSignal,
    progress: () => void | Promise<void>,
  ): Promise<void> {
    // Limit each synchronous SQLite operation, including cancellation and read latency.
    const pages = async (update: (ids: string[]) => number) => {
      let after = "",
        changes = 0;
      for (;;) {
        signal.throwIfAborted();
        const rows = this.statement(
          "SELECT id FROM sources WHERE instance=? AND id>? ORDER BY id LIMIT 256",
        ).all(instance, after);
        if (!rows.length) return changes;
        const ids = rows.map((row) => z.string().parse(row.id));
        after = ids.at(-1) ?? after;
        changes += update(ids);
        await progress();
        await setImmediate();
      }
    };
    await pages((ids) =>
      Number(
        this.statement(
          `UPDATE sources SET activity=own_activity,summary=json_set(summary,'$.lastActivity',own_activity) WHERE id IN (${ids.map(() => "?").join(",")})`,
        ).run(...ids).changes,
      ),
    );
    const recency =
      "MAX(own_activity,COALESCE((SELECT MAX(child.activity) FROM sources child WHERE child.instance=parent.instance AND child.parent=parent.native),own_activity))";
    for (let depth = 0; depth < 16; depth++) {
      const changes = await pages((ids) =>
        Number(
          this.statement(
            `UPDATE sources AS parent SET activity=${recency},summary=json_set(summary,'$.lastActivity',${recency}) WHERE id IN (${ids.map(() => "?").join(",")}) AND activity<>${recency}`,
          ).run(...ids).changes,
        ),
      );
      if (!changes) break;
    }
  }
  async prune(instance: string, epoch: number, signal: AbortSignal): Promise<void> {
    for (const table of ["sources", "files"]) {
      for (;;) {
        signal.throwIfAborted();
        const result = this.statement(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE instance=? AND epoch<>? LIMIT 256)`,
        ).run(instance, epoch);
        if (!Number(result.changes)) break;
        await setImmediate();
      }
    }
  }
  get(id: string): Source | undefined {
    const row = this.readStatement("SELECT * FROM visible_sources WHERE id=?").get(id);
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
      ? this.readStatement(
          "SELECT id,activity,summary FROM visible_sources sources WHERE cwd=? AND parent IS NULL AND (kind<>'database' OR NOT EXISTS (SELECT 1 FROM visible_sources preferred WHERE preferred.instance=sources.instance AND preferred.native=sources.native AND preferred.kind='jsonl')) AND (activity<? OR (activity=? AND id<?)) ORDER BY activity DESC,id DESC LIMIT ?",
        ).all(cwd, before.lastActivity, before.lastActivity, before.id, limit + 1)
      : this.readStatement(
          "SELECT id,activity,summary FROM visible_sources sources WHERE cwd=? AND parent IS NULL AND (kind<>'database' OR NOT EXISTS (SELECT 1 FROM visible_sources preferred WHERE preferred.instance=sources.instance AND preferred.native=sources.native AND preferred.kind='jsonl')) ORDER BY activity DESC,id DESC LIMIT ?",
        ).all(cwd, limit + 1);
    const sessions = rows.slice(0, limit).map((r) =>
      HistorySession.parse({
        ...HistorySession.parse(JSON.parse(String(r.summary))),
        lastActivity: z.number().int().nonnegative().parse(r.activity),
      }),
    );
    const last = rows.slice(0, limit).at(-1);
    return HistoryListResponse.parse({
      type: "history.list",
      sessions,
      next:
        rows.length > limit && last
          ? {
              lastActivity: z.number().int().nonnegative().parse(last.activity),
              id: z.string().parse(last.id),
            }
          : null,
    });
  }
  children(instance: string, native: string): Source[] {
    return this.statement("SELECT id FROM sources WHERE instance=? AND parent=? LIMIT 513")
      .all(instance, native)
      .map((r) => this.get(String(r.id)))
      .filter((s): s is Source => s !== undefined);
  }
  close(): void {
    this.reader.close();
    this.db.close();
  }
}
