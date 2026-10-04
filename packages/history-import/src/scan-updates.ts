import type { DatabaseSync } from "node:sqlite";
import { sep } from "node:path";
import { setImmediate } from "node:timers/promises";

/** Path and ancestor indexes keep incremental reconciliation proportional to changed sources. */
export class ScanUpdates {
  private db: DatabaseSync;
  private mark;
  private put;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(
      "CREATE TEMP TABLE dirty_native(instance TEXT,native TEXT,PRIMARY KEY(instance,native)) WITHOUT ROWID",
    );
    this.mark =
      db.prepare(`INSERT OR IGNORE INTO dirty_native SELECT instance,native FROM sources WHERE instance=? AND (path=? OR (path>=? AND path<?))
      UNION SELECT instance,parent FROM sources WHERE instance=? AND parent IS NOT NULL AND (path=? OR (path>=? AND path<?))`);
    this.put = db.prepare("INSERT OR IGNORE INTO dirty_native VALUES (?,?)");
  }
  begin(): void {
    this.db.exec("DELETE FROM dirty_native");
  }
  path(instance: string, path: string): void {
    const low = path + sep,
      high = path + String.fromCharCode(sep.charCodeAt(0) + 1);
    this.mark.run(instance, path, low, high, instance, path, low, high);
  }
  source(instance: string, native: string, parent?: string): void {
    this.put.run(instance, native);
    if (parent) this.put.run(instance, parent);
  }
  async prune(instance: string, path: string, epoch: number, signal: AbortSignal): Promise<void> {
    const low = path + sep,
      high = path + String.fromCharCode(sep.charCodeAt(0) + 1);
    for (const table of ["sources", "files"]) {
      const remove = this.db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE instance=? AND epoch<>? AND (path=? OR (path>=? AND path<?)) LIMIT 256)`,
      );
      for (;;) {
        signal.throwIfAborted();
        if (!Number(remove.run(instance, epoch, path, low, high).changes)) break;
        await setImmediate();
      }
    }
  }
  async summarize(instance: string, signal: AbortSignal): Promise<void> {
    const ancestors = this.db
      .prepare(`INSERT OR IGNORE INTO dirty_native SELECT instance,parent FROM sources
      WHERE instance=? AND native IN (SELECT native FROM dirty_native WHERE instance=?) AND parent IS NOT NULL`);
    for (let depth = 0; depth < 16; depth++) {
      signal.throwIfAborted();
      if (!Number(ancestors.run(instance, instance).changes)) break;
      await setImmediate();
    }
    this.db
      .prepare(`UPDATE sources SET activity=own_activity,summary=json_set(summary,'$.lastActivity',own_activity)
      WHERE instance=? AND native IN (SELECT native FROM dirty_native WHERE instance=?)`)
      .run(instance, instance);
    const recency =
      "MAX(own_activity,COALESCE((SELECT MAX(child.activity) FROM sources child WHERE child.instance=parent.instance AND child.parent=parent.native),own_activity))";
    const update = this.db
      .prepare(`UPDATE sources AS parent SET activity=${recency},summary=json_set(summary,'$.lastActivity',${recency})
      WHERE instance=? AND native IN (SELECT native FROM dirty_native WHERE instance=?) AND activity<>${recency}`);
    for (let depth = 0; depth < 16; depth++) {
      signal.throwIfAborted();
      if (!Number(update.run(instance, instance).changes)) break;
      await setImmediate();
    }
  }
}
