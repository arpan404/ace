import { Attachment, BlobHash, type ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/** Durable input correlation, independent of transcript bodies and native echo timing. */
export class AttachmentCorrelations {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_attachment_inputs (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, intent_id INTEGER NOT NULL,
      attachment JSON NOT NULL, PRIMARY KEY(thread_id,sha256)
    ) WITHOUT ROWID`),
    );
  }
  remember(thread: ThreadId, intent: number, attachments: readonly Attachment[]): void {
    const parsed = Attachment.array().max(64).parse(attachments);
    this.store.atomic(() => {
      const insert = this.store.statement(`INSERT INTO engine_attachment_inputs VALUES (?,?,?,?)
        ON CONFLICT(thread_id,sha256) DO UPDATE SET intent_id=excluded.intent_id,attachment=excluded.attachment`);
      for (const attachment of parsed)
        insert.run(thread, attachment.sha256, intent, JSON.stringify(attachment));
    });
  }
  get(thread: ThreadId, hash: string): Attachment | undefined {
    const row = this.store
      .statement("SELECT attachment FROM engine_attachment_inputs WHERE thread_id=? AND sha256=?")
      .get(thread, BlobHash.parse(hash));
    return row ? Attachment.parse(JSON.parse(String(row.attachment))) : undefined;
  }
}
