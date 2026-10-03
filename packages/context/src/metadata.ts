import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { Attachment, BlobHash } from "@ace/protocol";

export const UploadRow = z.object({
  id: z.string().regex(/^[\w-]{1,128}$/),
  device: z.string(),
  thread: z.string(),
  sha256: BlobHash,
  bytes: z.number().int().positive(),
  name: z.string().max(255),
  offset: z.number().int().nonnegative(),
  expires: z.number(),
  done: z.number().int().min(0).max(1),
});
export type UploadRow = z.infer<typeof UploadRow>;
export class Metadata {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, name TEXT NOT NULL, offset INTEGER NOT NULL, expires INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS uploads_expiry ON uploads(expires);
      CREATE INDEX IF NOT EXISTS uploads_hash ON uploads(sha256,done);
      CREATE TABLE IF NOT EXISTS blobs(sha256 TEXT PRIMARY KEY, metadata TEXT NOT NULL, refs INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS unreferenced ON blobs(refs);
      CREATE TABLE IF NOT EXISTS refs(thread TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES blobs(sha256), name TEXT NOT NULL, PRIMARY KEY(thread,sha256));
      CREATE TABLE IF NOT EXISTS usage(scope TEXT PRIMARY KEY, bytes INTEGER NOT NULL, count INTEGER NOT NULL);
      INSERT OR IGNORE INTO usage VALUES('*',0,0);
      CREATE TABLE IF NOT EXISTS storage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,count INTEGER NOT NULL);
      INSERT OR IGNORE INTO storage SELECT 1,
        COALESCE((SELECT SUM(json_extract(metadata,'$.bytes')) FROM blobs),0)+COALESCE((SELECT SUM(bytes) FROM uploads WHERE done=0),0),
        (SELECT COUNT(*) FROM blobs)+(SELECT COUNT(*) FROM uploads WHERE done=0);

    `);
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  get(sql: string, ...params: SQLInputValue[]) {
    return this.statement(sql).get(...params);
  }
  all(sql: string, ...params: SQLInputValue[]) {
    return this.statement(sql).all(...params);
  }
  run(sql: string, ...params: SQLInputValue[]): void {
    this.statement(sql).run(...params);
  }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  upload(id: string): UploadRow | undefined {
    const row = this.get("SELECT * FROM uploads WHERE id=?", id);
    return row ? UploadRow.parse(row) : undefined;
  }
  blob(hash: string): Attachment | undefined {
    const row = this.get("SELECT metadata FROM blobs WHERE sha256=?", hash);
    return row ? Attachment.parse(JSON.parse(z.string().parse(row.metadata))) : undefined;
  }
  usage(scope: string): { bytes: number; count: number } {
    return z
      .object({ bytes: z.number(), count: z.number() })
      .parse(
        this.get("SELECT bytes,count FROM usage WHERE scope=?", scope) ?? { bytes: 0, count: 0 },
      );
  }
  storage(): { bytes: number; count: number } {
    return z
      .object({ bytes: z.number(), count: z.number() })
      .parse(this.get("SELECT bytes,count FROM storage WHERE id=1"));
  }
  adjustStorage(bytes: number, count: number): void {
    this.run("UPDATE storage SET bytes=bytes+?,count=count+? WHERE id=1", bytes, count);
  }
  adjust(thread: string, bytes: number, count: number): void {
    for (const scope of [thread, "*"])
      this.run(
        "INSERT INTO usage VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET bytes=bytes+excluded.bytes,count=count+excluded.count",
        scope,
        bytes,
        count,
      );
    this.run("DELETE FROM usage WHERE scope=? AND bytes=0 AND count=0", thread);
  }
  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
