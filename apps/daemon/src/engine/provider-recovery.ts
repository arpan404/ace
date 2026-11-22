import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, Translator } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { sessionStoreUnusable } from "@ace/provider-kit/open-error";
import { cursorStoreUnusable } from "@ace/adapter-cursor/store-fence";
import type { Store } from "../store.ts";

const CapturedFrame = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.literal("sdk"),
  data: z.unknown(),
});
const Offset = z.object({ boundaryOffset: z.number().int().positive().max(10000000).optional() });
const HostFence = z.object({
  kind: z.literal("error"),
  body: z.object({
    code: z.enum(["boundary_overflow", "checkpoint_budget"]),
    message: z.string().max(4096).optional().catch(undefined),
  }),
});
/** The saved session can never be opened again: the engine hands off instead (ADR 0211). */
const unusable = (message: string) =>
  Object.assign(new Error(message), { code: sessionStoreUnusable });

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
            "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT 8",
          ),
          db.prepare("SELECT offset FROM engine_provider_cursors WHERE thread_id=?"),
          db.prepare(
            "INSERT INTO engine_provider_cursors VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET offset=excluded.offset",
          ),
        ] satisfies [StatementSync, StatementSync, StatementSync],
    );
  }
  /** Hydrate pure translation only; canonical facts already committed are never reapplied. */
  async restore(threadId: ThreadId, translator: Translator): Promise<void> {
    let rowid = 0;
    do {
      const rows = this.store.atomic(() => this.readFrames.all(threadId, rowid));
      if (!rows.length) return;
      for (const row of rows) {
        const encoded = z.string().max(1048576).parse(row.frame);
        const parsed = CapturedFrame.parse(JSON.parse(encoded));
        const payload = new ProviderPayload(JSON.stringify(parsed.data));
        const frame: Frame = { ...parsed, data: payload.data, payload };
        const facts = translator.translate(frame, parsed.t);
        // A previous host's emergency fence is historical, not a translator overflow.
        // Opening the replacement host still verifies its journal, quota, ownership
        // and native run state before any new send can reach the pinned checkpoint.
        const fence = HostFence.safeParse(frame.data);
        if (facts.some((fact) => fact.type === "process.exited") && !fence.success)
          throw unusable(
            "SDK translation provenance is fenced by its budget; use bounded context handoff",
          );
        // A checkpoint that outgrew its budget would fence the next turn the same way: the
        // saved session is not resumed at all.
        if (
          fence.success &&
          fence.data.body.code === "checkpoint_budget" &&
          cursorStoreUnusable(fence.data.body.message)
        )
          throw unusable(fence.data.body.message ?? "Cursor's checkpoint exceeds its budget");
        rowid = z.number().int().positive().parse(row.rowid);
      }
      await yieldImmediate();
    } while (rowid > 0);
  }
  /** Forgets a session's frames and boundary cursor: the thread's next session starts fresh. */
  reset(threadId: ThreadId): void {
    this.store.atomic(() => {
      this.store.statement("DELETE FROM engine_provider_frames WHERE thread_id=?").run(threadId);
      this.store.statement("DELETE FROM engine_provider_cursors WHERE thread_id=?").run(threadId);
    });
  }
  /** Settled turns have no live identities to hydrate. Keep the latest session open. */
  beginTurn(threadId: ThreadId): void {
    this.store.atomic(() =>
      this.store
        .statement(`DELETE FROM engine_provider_frames
      WHERE thread_id=? AND rowid<>COALESCE((SELECT MAX(rowid) FROM engine_provider_frames
        WHERE thread_id=? AND json_extract(frame,'$.data.kind')='open'),0)`)
        .run(threadId, threadId),
    );
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
  /** The boundary an SDK frame commits, if it carries one. Reads nothing. */
  boundary(frame: Frame): number | undefined {
    if (frame.channel !== "sdk") return undefined;
    return Offset.parse(frame.data).boundaryOffset;
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
