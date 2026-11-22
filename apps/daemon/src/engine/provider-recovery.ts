import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, Translator } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { sessionStoreUnusable } from "@ace/provider-kit/open-error";
import { cursorStoreUnusable } from "@ace/adapter-cursor/store-fence";
import { UnsettledRuns, type Unsettled } from "@ace/adapter-cursor/unsettled";
import type { Store } from "../store.ts";

const CapturedFrame = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.literal("sdk"),
  data: z.unknown(),
});
const Admission = z.object({
  kind: z.literal("admission"),
  body: z.object({ admitted: z.boolean(), commandId: z.string().min(1).max(512).optional() }),
});

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
  private readAttempt: StatementSync;
  private readAdmission: StatementSync;
  private readOutput: StatementSync;
  constructor(store: Store) {
    this.store = store;
    [this.readFrames, this.readAttempt, this.readAdmission, this.readOutput] = store.atomic(
      (db) =>
        [
          db.prepare(
            "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT 8",
          ),
          db.prepare(
            "SELECT 1 FROM engine_provider_frames WHERE thread_id=? AND json_extract(frame,'$.data.kind')='send' AND json_extract(frame,'$.data.commandId')=? LIMIT 1",
          ),
          db.prepare(
            "SELECT frame FROM engine_provider_frames WHERE thread_id=? AND json_extract(frame,'$.data.kind')='admission' ORDER BY rowid DESC LIMIT 1",
          ),
          // A segment, a run id or any output under the send's operation is admission evidence.
          db.prepare(
            "SELECT 1 FROM engine_provider_frames WHERE thread_id=? AND (json_extract(frame,'$.data.commandId')=? OR json_extract(frame,'$.data.operationId')=?) AND json_extract(frame,'$.data.kind') NOT IN ('send','admission','error','cancel','host-exit','host-output','snapshot') LIMIT 1",
          ),
        ] satisfies [StatementSync, StatementSync, StatementSync, StatementSync],
    );
  }
  /**
   * Hydrate pure translation only; canonical facts already committed are never reapplied. The
   * daemon's committed frames are ace's only Cursor record (ADR 0043, amendment of 2026-11-22):
   * what they lack of the open turn is returned for the reopened host to read from its store.
   */
  async restore(threadId: ThreadId, translator: Translator): Promise<Unsettled> {
    const unsettled = new UnsettledRuns();
    let rowid = 0;
    do {
      const rows = this.store.atomic(() => this.readFrames.all(threadId, rowid));
      if (!rows.length) return unsettled.result();
      for (const row of rows) {
        const encoded = z.string().max(1048576).parse(row.frame);
        const parsed = CapturedFrame.parse(JSON.parse(encoded));
        const payload = new ProviderPayload(JSON.stringify(parsed.data));
        const frame: Frame = { ...parsed, data: payload.data, payload };
        const facts = translator.translate(frame, parsed.t);
        unsettled.add(frame.data);
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
    return unsettled.result();
  }
  /**
   * True when the host stored its attempt to send `commandId` (ADR 0043, amendment of
   * 2026-11-22). The host calls Cursor only once that attempt is committed, so without it the
   * input never reached Cursor and is delivered again.
   */
  attempted(threadId: ThreadId, commandId: string): boolean {
    return this.store.atomic(() => this.readAttempt.get(threadId, commandId) !== undefined);
  }
  /**
   * The newest admission a reopened Cursor host read back from its store, if any: whether Cursor
   * ever had the send the daemon saw attempted (ADR 0043, amendment of 2026-11-22).
   */
  lastAdmission(threadId: ThreadId): { commandId?: string; admitted: boolean } | undefined {
    const row = this.store.atomic(() => this.readAdmission.get(threadId));
    if (!row) return undefined;
    const frame = CapturedFrame.safeParse(JSON.parse(z.string().parse(row.frame)));
    const body = Admission.safeParse(frame.success ? frame.data.data : undefined);
    return body.success
      ? {
          admitted: body.data.body.admitted,
          ...(body.data.body.commandId ? { commandId: body.data.body.commandId } : {}),
        }
      : undefined;
  }
  /** True when anything of `commandId`'s send beyond the attempt itself was recorded. */
  admissionRecorded(threadId: ThreadId, commandId: string): boolean {
    return this.store.atomic(
      () => this.readOutput.get(threadId, commandId, commandId) !== undefined,
    );
  }
  /** Forgets a session's frames (and an earlier build's boundary cursor): it starts fresh. */
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
}
