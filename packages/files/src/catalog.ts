import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
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
});
export type UploadRecord = z.infer<typeof UploadRecord>;
export const TrashRecord = z.object({
  ...common,
  kind: z.literal("trash"),
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
});
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;
const Record = z.discriminatedUnion("kind", [UploadRecord, TrashRecord, ArtifactRecord]);
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
    this.remove = this.db.prepare("DELETE FROM resources WHERE id=?");
  }
  get(id: string): Record {
    const row = this.getRow.get(id);
    if (!row) throw new FileError("NOT_FOUND", "Resource not found");
    return Record.parse(JSON.parse(Row.parse(row).body));
  }
  list(kind: Record["kind"]): Record[] {
    return this.listRows.all(kind).map((row) => Record.parse(JSON.parse(Row.parse(row).body)));
  }
  total(kind: Record["kind"]): { count: number; bytes: number } {
    return Total.parse(this.totals.get(kind));
  }
  put(record: Record): void {
    this.insert.run(record.id, record.kind, record.expires, record.bytes, JSON.stringify(record));
  }
  delete(id: string): void {
    this.remove.run(id);
  }
  close(): void {
    this.db.close();
  }
}
