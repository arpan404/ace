import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, Translator } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

const CapturedFrame = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.literal("sdk"),
  data: z.unknown(),
});
const Offset = z.object({ boundaryOffset: z.number().int().positive().max(10000000).optional() });

/** One prepared cursor owner; updates share the transaction that commits canonical facts. */
export class ProviderRecovery {
  private store: Store;
  private readFrames: StatementSync;
  private readCursor: StatementSync;
  private writeCursor: StatementSync;
  constructor(store: Store) {
    this.store = store;
    [this.readFrames, this.readCursor, this.writeCursor] = store.atomic(
      (db) =>
        [
          db.prepare(
            "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT 64",
          ),
          db.prepare("SELECT offset FROM engine_provider_cursors WHERE thread_id=?"),
          db.prepare(
            "INSERT INTO engine_provider_cursors VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET offset=excluded.offset",
          ),
        ] satisfies [StatementSync, StatementSync, StatementSync],
    );
  }
  /** Hydrate pure translation only; canonical facts already committed are never reapplied. */
  restore(threadId: ThreadId, translator: Translator): void {
    let rowid = 0;
    let bytes = 0;
    do {
      const rows = this.store.atomic(() => this.readFrames.all(threadId, rowid));
      if (!rows.length) return;
      for (const row of rows) {
        const encoded = z.string().max(1048576).parse(row.frame);
        bytes += Buffer.byteLength(encoded);
        if (bytes > 16777216)
          throw new Error("SDK provenance exceeds recovery budget; use explicit context handoff");
        const parsed = CapturedFrame.parse(JSON.parse(encoded));
        const payload = new ProviderPayload(JSON.stringify(parsed.data));
        const frame: Frame = { ...parsed, data: payload.data, payload };
        const facts = translator.translate(frame, parsed.t);
        if (facts.some((fact) => fact.type === "process.exited"))
          throw new Error(
            "SDK translation provenance is fenced by its budget; use bounded context handoff",
          );
        rowid = z.number().int().positive().parse(row.rowid);
      }
    } while (rowid > 0);
  }
  offset(threadId: ThreadId): number {
    return this.store.atomic(() =>
      z
        .number()
        .int()
        .nonnegative()
        .max(10000000)
        .parse(Number(this.readCursor.get(threadId)?.offset ?? 0)),
    );
  }
  committed(threadId: ThreadId, frame: Frame): boolean {
    if (frame.channel !== "sdk") return false;
    const offset = Offset.parse(frame.data).boundaryOffset;
    return offset !== undefined && offset <= this.offset(threadId);
  }
  commit(threadId: ThreadId, frame: Frame): void {
    if (frame.channel !== "sdk") return;
    const offset = Offset.parse(frame.data).boundaryOffset;
    if (offset === undefined) return;
    if (offset !== this.offset(threadId) + 1)
      throw new Error("SDK boundary journal has a missing commit; sends are fenced");
    this.store.atomic(() => this.writeCursor.run(threadId, offset));
  }
}
