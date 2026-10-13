import type { DatabaseSync } from "@ace/provider-kit/sqlite";

const BASE_MS = 30_000;
const MAX_MS = 60 * 60_000;

/**
 * Provider databases that failed to read (refused snapshot, checkpoint race, unknown schema)
 * wait before being opened again: 30 s doubling to one hour. State lives in the private index,
 * so idle-worker restarts and daemon restarts keep honouring it.
 */
export class ReadBackoff {
  private db: DatabaseSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
    db.exec(
      "CREATE TABLE IF NOT EXISTS provider_db_backoff(instance TEXT NOT NULL,path TEXT NOT NULL,failures INTEGER NOT NULL,retry_at REAL NOT NULL,reason TEXT,PRIMARY KEY(instance,path))",
    );
  }
  /** While waiting, returns the last failure's notice ("" for silent races). */
  waiting(instance: string, path: string): string | undefined {
    const row = this.db
      .prepare("SELECT retry_at,reason FROM provider_db_backoff WHERE instance=? AND path=?")
      .get(instance, path);
    if (row === undefined || this.now() >= Number(row.retry_at)) return undefined;
    return typeof row.reason === "string" ? row.reason : "";
  }
  failed(instance: string, path: string, reason: string | undefined): void {
    const row = this.db
      .prepare("SELECT failures FROM provider_db_backoff WHERE instance=? AND path=?")
      .get(instance, path);
    const failures = Number(row?.failures ?? 0) + 1;
    const delay = Math.min(MAX_MS, BASE_MS * 2 ** Math.min(failures - 1, 16));
    this.db
      .prepare("INSERT OR REPLACE INTO provider_db_backoff VALUES(?,?,?,?,?)")
      .run(instance, path, failures, this.now() + delay, reason ?? null);
  }
  succeeded(instance: string, path: string): void {
    this.db
      .prepare("DELETE FROM provider_db_backoff WHERE instance=? AND path=?")
      .run(instance, path);
  }
}
