import { DatabaseSync, type StatementSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import { FileError } from "./types.ts";

const common = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expires: z.number(),
  bytes: z.number().nonnegative(),
};
export const UploadRecord = z.object({
  ...common,
  kind: z.literal("upload"),
  device: z.string(),
  path: z.string(),
  temp: z.string().regex(/^\.ace-upload-[a-zA-Z0-9_-]{1,128}$/),
  identity: z.string(),
  expected: z.string().nullable(),
  cleanup: z.boolean().default(false),
  mode: z.number().int().min(0).max(0o777).optional(),
  verified: z
    .object({
      mtimeMs: z.number(),
      birthtimeMs: z.number(),
      mode: z.number().int().min(0).max(0o777),
    })
    .optional(),
  publishing: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type UploadRecord = z.infer<typeof UploadRecord>;
export const UploadReceipt = z.object({
  ...common,
  kind: z.literal("upload.completed"),
  device: z.string(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  permissions: z
    .object({ identity: z.string(), mode: z.number().int().min(0).max(0o777) })
    .optional(),
});
export type UploadReceipt = z.infer<typeof UploadReceipt>;
export const TrashRecord = z.object({
  ...common,
  kind: z.literal("trash"),
  location: z
    .string()
    .regex(/^\.ace-upload-trash-[a-zA-Z0-9_-]{1,128}$/)
    .optional(),
  path: z.string(),
  version: z.string(),
});
export type TrashRecord = z.infer<typeof TrashRecord>;
export const ArtifactRecord = z.object({
  ...common,
  kind: z.literal("artifact"),
  root: z.string(),
  path: z.string(),
  name: z.string().max(256),
  category: z.enum(["recording", "screenshot", "support", "output", "other"]),
  sourceThread: ThreadId.optional(),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;
const Record = z.discriminatedUnion("kind", [
  UploadRecord,
  UploadReceipt,
  TrashRecord,
  ArtifactRecord,
]);
type Record = z.infer<typeof Record>;
const Row = z.object({ body: z.string() });
const Total = z.object({ count: z.number(), bytes: z.number() });

/** Small metadata only. File bytes never enter SQLite or event payloads. */
export class Catalog {
  private readonly db: DatabaseSync;
  private readonly getRow: StatementSync;
  private readonly listRows: StatementSync;
  private readonly totals: StatementSync;
  private readonly insert: StatementSync;
  private readonly remove: StatementSync;
  private readonly trashPage: StatementSync;
  private readonly artifactReplace: StatementSync;
  private readonly cleanupDebt: StatementSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires REAL NOT NULL, bytes REAL NOT NULL, body TEXT NOT NULL)",
    );
    this.getRow = this.db.prepare("SELECT body FROM resources WHERE id=?");
    this.listRows = this.db.prepare("SELECT body FROM resources WHERE kind=? ORDER BY id");
    this.totals = this.db.prepare(
      "SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM resources WHERE kind=?",
    );
    this.insert = this.db.prepare("INSERT INTO resources VALUES(?,?,?,?,?)");
    this.cleanupDebt = this.db.prepare(
      "UPDATE resources SET body=json_set(body, '$.cleanup', json('true')) WHERE id=? AND kind='upload'",
    );
    this.artifactReplace = this.db.prepare(
      "UPDATE resources SET body=?, bytes=? WHERE id=? AND kind='artifact'",
    );
    this.remove = this.db.prepare("DELETE FROM resources WHERE id=?");
    this.db.exec("CREATE INDEX IF NOT EXISTS resources_kind_id ON resources(kind,id)");
    this.trashPage = this.db.prepare(
      "SELECT body FROM resources WHERE kind='trash' AND id>? AND expires>? ORDER BY id LIMIT ?",
    );
  }
  get(id: string): Record {
    const row = this.getRow.get(id);
    if (!row) throw new FileError("NOT_FOUND", "Resource not found");
    return Record.parse(JSON.parse(Row.parse(row).body));
  }
  list(kind: Record["kind"]): Record[] {
    return this.listRows.all(kind).map((row) => Record.parse(JSON.parse(Row.parse(row).body)));
  }
  listTrash(after: string, now: number, limit: number) {
    const rows = this.trashPage
      .all(after, now, limit + 1)
      .map((row) => TrashRecord.parse(JSON.parse(Row.parse(row).body)));
    const page = rows.slice(0, limit);
    return {
      entries: page.map((record) => ({
        id: record.id,
        path: record.path,
        size: record.bytes,
        version: record.version,
        expires: record.expires,
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
  total(kind: Record["kind"]): { count: number; bytes: number } {
    return Total.parse(this.totals.get(kind));
  }
  put(record: Record): void {
    this.insert.run(record.id, record.kind, record.expires, record.bytes, JSON.stringify(record));
  }
  publishUpload(record: UploadRecord): void {
    this.db
      .prepare("UPDATE resources SET body=? WHERE id=? AND kind='upload'")
      .run(JSON.stringify(record), record.id);
  }
  completeUpload(receipt: UploadReceipt): void {
    // One durable row transition releases both quota and ownership exactly once.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE resources SET kind=?,bytes=0,expires=?,body=? WHERE id=? AND kind='upload'",
        )
        .run(receipt.kind, receipt.expires, JSON.stringify(receipt), receipt.id);
      this.db
        .prepare(
          "DELETE FROM resources WHERE kind='upload.completed' AND id NOT IN (SELECT id FROM resources WHERE kind='upload.completed' ORDER BY expires DESC,id DESC LIMIT 128)",
        )
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finishUploadPermissions(receipt: UploadReceipt): void {
    this.db
      .prepare("UPDATE resources SET body=? WHERE id=? AND kind='upload.completed'")
      .run(JSON.stringify(receipt), receipt.id);
  }
  markUploadCleanup(id: string): void {
    this.cleanupDebt.run(id);
  }
  replaceArtifact(record: ArtifactRecord): void {
    this.artifactReplace.run(JSON.stringify(record), record.bytes, record.id);
  }
  delete(id: string): void {
    this.remove.run(id);
  }
  close(): void {
    this.db.close();
  }
}
