import { Attachment, type EventPayload, type ThreadId } from "@ace/protocol";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Immutable native-tool images, indexed separately from provider snapshots. */
export class NativeImageStore {
  private sql: (query: string) => StatementSync;
  constructor(db: DatabaseSync, sql: (query: string) => StatementSync) {
    this.sql = sql;
    db.exec(`CREATE TABLE IF NOT EXISTS native_images (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL, path TEXT NOT NULL, source TEXT, hash TEXT, attachment JSON, error TEXT,
      PRIMARY KEY(thread_id,item_id));
      CREATE INDEX IF NOT EXISTS native_image_reference ON native_images(thread_id,path);
      CREATE INDEX IF NOT EXISTS native_image_retention ON native_images(thread_id,hash);`);
  }
  decorate(thread: ThreadId, payload: EventPayload): EventPayload {
    if (payload.type !== "item.created" && payload.type !== "item.updated") return payload;
    const item = payload.item;
    if (item.type !== "tool_call" || item.call.detail.kind !== "image") return payload;
    const row = this.sql(
      "SELECT path,source,attachment,error FROM native_images WHERE thread_id=? AND item_id=?",
    ).get(thread, item.id);
    if (!row) return payload;
    return {
      ...payload,
      item: {
        ...item,
        call: {
          ...item.call,
          detail: {
            ...item.call.detail,
            path: String(row.path),
            ...(row.source ? { sourcePath: String(row.source) } : {}),
            ...(row.attachment
              ? { attachment: Attachment.parse(JSON.parse(String(row.attachment))) }
              : {}),
            ...(row.error ? { unavailable: String(row.error) } : {}),
          },
        },
      },
    };
  }
  has(thread: string, item: string): boolean {
    return !!this.sql("SELECT 1 FROM native_images WHERE thread_id=? AND item_id=?").get(
      thread,
      item,
    );
  }
  save(
    thread: string,
    item: string,
    path: string,
    attachment?: Attachment,
    source = path,
    error = "This image could not be saved from the agent's environment.",
  ): void {
    this.sql(
      "INSERT OR IGNORE INTO native_images(thread_id,item_id,path,source,hash,attachment,error) VALUES(?,?,?,?,?,?,?)",
    ).run(
      thread,
      item,
      path,
      source,
      attachment?.sha256 ?? null,
      attachment ? JSON.stringify(attachment) : null,
      attachment ? null : error,
    );
  }
  resolve(thread: string, reference: string, itemId?: string): Attachment | undefined {
    const row = this.sql(
      `SELECT native.attachment FROM native_images native JOIN items image ON image.thread_id=native.thread_id AND image.id=native.item_id
      WHERE native.thread_id=? AND (native.path=? OR native.source=?) AND native.attachment IS NOT NULL
      AND (? IS NULL OR EXISTS(SELECT 1 FROM items message WHERE message.thread_id=native.thread_id AND message.id=? AND image.created_seq<=message.created_seq
        AND (substr(?,1,1)='/' OR json_extract(image.item,'$.agentId')=json_extract(message.item,'$.agentId'))))
      ORDER BY image.created_seq DESC LIMIT 1`,
    ).get(thread, reference, reference, itemId ?? null, itemId ?? null, reference);
    return row ? Attachment.parse(JSON.parse(String(row.attachment))) : undefined;
  }
  retains(thread: string, hash: string): boolean {
    return !!this.sql("SELECT 1 FROM native_images WHERE thread_id=? AND hash=? LIMIT 1").get(
      thread,
      hash,
    );
  }
}
