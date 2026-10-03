import { z } from "zod";
import type { ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

/** Durable capabilities for paged conversation reads, independent of prompt delivery. */
export class HandoffAccess {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_handoff_grants (
      recipient TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      through_seq INTEGER NOT NULL, PRIMARY KEY(recipient, source)
    )`),
    );
  }
  admit(recipient: ThreadId, source: ThreadId): void {
    this.store.atomic((db) => {
      if (
        db
          .prepare("SELECT source FROM engine_handoff_grants WHERE recipient=? AND source=?")
          .get(recipient, source)
      )
        return;
      const count = Number(
        db
          .prepare("SELECT COUNT(*) AS n FROM engine_handoff_grants WHERE recipient=?")
          .get(recipient)?.n,
      );
      if (count >= 8) throw new Error("Handoff history grant capacity exceeded");
    });
  }
  grant(recipient: ThreadId, source: ThreadId, throughSeq: number): void {
    this.admit(recipient, source);
    this.store.atomic((db) =>
      db
        .prepare(`INSERT INTO engine_handoff_grants VALUES (?, ?, ?)
      ON CONFLICT(recipient,source) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)`)
        .run(recipient, source, throughSeq),
    );
  }
  boundary(recipient: ThreadId, source: ThreadId): number {
    if (recipient === source) return this.store.headSeq();
    return this.store.atomic((db) => {
      const row = db
        .prepare("SELECT through_seq FROM engine_handoff_grants WHERE recipient=? AND source=?")
        .get(recipient, source);
      if (!row) throw new Error("Source history is outside this handoff");
      return z.number().int().nonnegative().parse(row.through_seq);
    });
  }
  readStream(
    recipient: ThreadId,
    source: ThreadId,
    streamId: string,
    offset: number,
    limit: number,
  ) {
    return this.store.readHistoricalStream(
      source,
      streamId,
      this.boundary(recipient, source),
      offset,
      limit,
    );
  }
}
