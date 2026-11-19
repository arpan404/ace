import { z } from "zod";
import type { Store } from "../../store.ts";
import { threadFenceTable, threadOwnershipTable } from "../../thread-ownership-table.ts";
import {
  nextOwnership,
  ownershipRefusal,
  type Ownership,
  type OwnershipChange,
} from "./ownership-rules.ts";

export { OwnershipConflict, type Ownership, type OwnershipChange } from "./ownership-rules.ts";

const Peer = z.object({
  hostId: z.string(),
  name: z.string(),
  threadId: z.string().optional(),
});
const Row = z.object({
  thread_id: z.string(),
  state: z.enum(["stopping", "handing", "moved", "owned"]),
  transfer_id: z.string(),
  peer: z.string(),
  epoch: z.number(),
  prior: z.string().nullable(),
  at: z.number(),
});
const Prior = z.object({ peer: Peer, epoch: z.number(), transferId: z.string() });

/**
 * The durable record of which machine owns a thread (ADR 0191), one row per thread whose owner
 * isn't simply this machine. Every change goes through `nextOwnership` inside one transaction,
 * so two changes can't both pass. The lid-close stage adds its lease to the same row.
 */
export class ThreadOwnership {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    // A new, empty table: nothing here grows with stored history at open (ADR 0170).
    store.atomic((db) => {
      db.exec(threadOwnershipTable);
      db.exec(threadFenceTable);
    });
  }
  get(threadId: string): Ownership | undefined {
    const raw = this.store
      .statement("SELECT * FROM thread_ownership WHERE thread_id=?")
      .get(threadId);
    if (!raw) return undefined;
    const row = Row.parse(raw);
    return {
      threadId: row.thread_id,
      state: row.state,
      transferId: row.transfer_id,
      peer: Peer.parse(JSON.parse(row.peer)),
      epoch: row.epoch,
      ...(row.prior ? { prior: Prior.parse(JSON.parse(row.prior)) } : {}),
      at: row.at,
    };
  }
  /** Applies one change; throws `OwnershipConflict` when it would leave two owners or none. */
  change(threadId: string, change: OwnershipChange): Ownership | undefined {
    return this.store.atomic(() => {
      const next = nextOwnership(this.get(threadId), threadId, change);
      if (!next) {
        this.store.statement("DELETE FROM thread_ownership WHERE thread_id=?").run(threadId);
        return undefined;
      }
      this.store
        .statement(
          `INSERT INTO thread_ownership (thread_id,state,transfer_id,peer,epoch,prior,at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,
          transfer_id=excluded.transfer_id, peer=excluded.peer, epoch=excluded.epoch,
          prior=excluded.prior, at=excluded.at`,
        )
        .run(
          threadId,
          next.state,
          next.transferId,
          JSON.stringify(next.peer),
          next.epoch,
          next.prior ? JSON.stringify(next.prior) : null,
          next.at,
        );
      return next;
    });
  }
  /**
   * Why the thread takes no new turn here; none while it may. A subagent of a moving thread is
   * fenced by its root's record.
   */
  refusal(threadId: string) {
    const own = ownershipRefusal(this.get(threadId));
    if (own) return own;
    const fence = this.store
      .statement("SELECT root_id FROM thread_fence WHERE thread_id=?")
      .get(threadId);
    return fence ? ownershipRefusal(this.get(String(fence["root_id"]))) : undefined;
  }
  /** Fences the rest of a moving thread's tree here with it, until `unfenceTree`. */
  fenceTree(rootId: string, threadIds: readonly string[]): void {
    this.store.atomic(() => {
      for (const threadId of threadIds)
        if (threadId !== rootId)
          this.store
            .statement(
              "INSERT INTO thread_fence (thread_id, root_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET root_id=excluded.root_id",
            )
            .run(threadId, rootId);
    });
  }
  /** The move ended without the thread leaving: its tree runs here again. Returns who. */
  unfenceTree(rootId: string): string[] {
    return this.store.atomic(() => {
      const ids = this.store
        .statement("SELECT thread_id FROM thread_fence WHERE root_id=? LIMIT 1024")
        .all(rootId)
        .map((row) => String(row["thread_id"]));
      this.store.statement("DELETE FROM thread_fence WHERE root_id=?").run(rootId);
      return ids;
    });
  }
}
