import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, Translator } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { sessionStoreUnusable } from "@ace/provider-kit/open-error";
import { cursorStoreUnusable } from "@ace/adapter-cursor/store-fence";
import {
  UnsettledRuns,
  noteAttempt,
  type AttemptRecord,
  type Unsettled,
} from "@ace/adapter-cursor/unsettled";
import type { Store } from "../store.ts";
import { storedAttemptRecord, storedFramesRecord } from "../stored-decode.ts";

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
  private readRecord: StatementSync;
  private writeRecord: StatementSync;
  private readFramesRecord: StatementSync;
  private writeFramesRecord: StatementSync;
  private trimFrames: StatementSync;
  constructor(store: Store) {
    this.store = store;
    [
      this.readFrames,
      this.readAttempt,
      this.readAdmission,
      this.readOutput,
      this.readRecord,
      this.writeRecord,
      this.readFramesRecord,
      this.writeFramesRecord,
      this.trimFrames,
    ] = store.atomic(
      (db) =>
        [
          // Only the latest session's open frame and the open turn's frames, deleted or not yet.
          db.prepare(
            "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid>? AND (rowid>=? OR rowid=?) ORDER BY rowid LIMIT 8",
          ),
          db.prepare(
            // An earlier build's frames, with no attempt record: the newest frames only.
            "SELECT 1 FROM engine_provider_frames WHERE thread_id=? AND rowid IN (SELECT rowid FROM engine_provider_frames WHERE thread_id=? ORDER BY rowid DESC LIMIT 4096) AND json_extract(frame,'$.data.kind')='send' AND json_extract(frame,'$.data.commandId')=? LIMIT 1",
          ),
          db.prepare(
            "SELECT frame FROM engine_provider_frames WHERE thread_id=? AND rowid IN (SELECT rowid FROM engine_provider_frames WHERE thread_id=? ORDER BY rowid DESC LIMIT 4096) AND json_extract(frame,'$.data.kind')='admission' ORDER BY rowid DESC LIMIT 1",
          ),
          // A segment, a run id or any output under the send's operation is admission evidence.
          db.prepare(
            "SELECT 1 FROM engine_provider_frames WHERE thread_id=? AND rowid IN (SELECT rowid FROM engine_provider_frames WHERE thread_id=? ORDER BY rowid DESC LIMIT 4096) AND (json_extract(frame,'$.data.commandId')=? OR json_extract(frame,'$.data.operationId')=?) AND json_extract(frame,'$.data.kind') NOT IN ('send','admission','error','cancel','host-exit','host-output','snapshot','run') LIMIT 1",
          ),
          db.prepare(
            "SELECT value FROM engine_state_records WHERE thread_id=? AND section='cursorAttempt' AND key='latest'",
          ),
          db.prepare(
            "INSERT INTO engine_state_records VALUES (?,'cursorAttempt','latest',?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value",
          ),
          db.prepare(
            "SELECT value FROM engine_state_records WHERE thread_id=? AND section='cursorFrames' AND key='root'",
          ),
          db.prepare(
            "INSERT INTO engine_state_records VALUES (?,'cursorFrames','root',?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value",
          ),
          db.prepare(
            "DELETE FROM engine_provider_frames WHERE rowid IN (SELECT rowid FROM engine_provider_frames WHERE thread_id=? AND rowid<? AND rowid<>? ORDER BY rowid LIMIT 256)",
          ),
        ] satisfies [
          StatementSync,
          StatementSync,
          StatementSync,
          StatementSync,
          StatementSync,
          StatementSync,
          StatementSync,
          StatementSync,
          StatementSync,
        ],
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
      const { below = 0, open = 0 } = this.frames(threadId);
      const rows = this.store.atomic(() => this.readFrames.all(threadId, rowid, below, open));
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
   * The latest attempt's record, kept as frames commit (`noteAttempt`): a point read, never a
   * search of the thread's frames. Undefined for frames an earlier build stored.
   */
  private record(threadId: ThreadId): AttemptRecord | undefined {
    const row = this.store.atomic(() => this.readRecord.get(threadId));
    return row ? storedAttemptRecord(String(row.value)) : undefined;
  }
  /** Folds one committed Cursor frame into the attempt record, in the commit's transaction. */
  note(threadId: ThreadId, data: unknown): void {
    const before = this.record(threadId);
    const after = noteAttempt(before, data);
    if (after && after !== before) this.writeRecord.run(threadId, JSON.stringify(after));
  }
  /**
   * True when the host stored its attempt to send `commandId` (ADR 0043, amendment of
   * 2026-11-22). The host calls Cursor only once that attempt is committed, so without it the
   * input never reached Cursor and is delivered again.
   */
  attempted(threadId: ThreadId, commandId: string): boolean {
    const record = this.record(threadId);
    if (record?.commandId === commandId) return true;
    return this.store.atomic(
      () => this.readAttempt.get(threadId, threadId, commandId) !== undefined,
    );
  }
  /**
   * The newest admission a reopened Cursor host read back from its store, if any: whether Cursor
   * ever had the send the daemon saw attempted (ADR 0043, amendment of 2026-11-22).
   */
  lastAdmission(threadId: ThreadId): { commandId?: string; admitted: boolean } | undefined {
    const record = this.record(threadId);
    if (record) {
      return record.admitted === undefined
        ? undefined
        : { commandId: record.commandId, admitted: record.admitted };
    }
    const row = this.store.atomic(() => this.readAdmission.get(threadId, threadId));
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
    const record = this.record(threadId);
    if (record) return record.commandId === commandId && record.evidence;
    return this.store.atomic(
      () => this.readOutput.get(threadId, threadId, commandId, commandId) !== undefined,
    );
  }
  /** Forgets a session's frames (and an earlier build's boundary cursor): it starts fresh. */
  reset(threadId: ThreadId): void {
    this.store.atomic(() => {
      this.store.statement("DELETE FROM engine_provider_frames WHERE thread_id=?").run(threadId);
      this.store.statement("DELETE FROM engine_provider_cursors WHERE thread_id=?").run(threadId);
      this.store
        .statement("DELETE FROM engine_state_records WHERE thread_id=? AND section='cursorAttempt'")
        .run(threadId);
    });
  }
  /** Where the thread's frames stand: the latest session's open frame, and the open turn's start. */
  private frames(threadId: ThreadId): { open?: number; below?: number; trimmed?: boolean } {
    const row = this.store.atomic(() => this.readFramesRecord.get(threadId));
    return row ? storedFramesRecord(String(row.value)) : {};
  }
  /**
   * A frame this commit stored at `row`: the latest session's open frame, or the send that
   * starts a turn on a settled thread. Frames before that send, the open frame aside, belong to
   * settled turns: restore no longer reads them, and `trimStep` deletes them in batches.
   */
  captured(
    threadId: ThreadId,
    kind: string | undefined,
    row: number | undefined,
    beginsTurn: boolean,
  ) {
    if (row === undefined || (kind !== "open" && !beginsTurn)) return;
    const record = this.frames(threadId);
    const next =
      kind === "open" ? { ...record, open: row } : { ...record, below: row, trimmed: false };
    this.writeFramesRecord.run(threadId, JSON.stringify(next));
  }
  /** Deletes up to 256 frames of settled turns: a bounded step, in the commit it rides on. */
  trimStep(threadId: ThreadId): void {
    const record = this.frames(threadId);
    if (record.below === undefined || record.trimmed) return;
    const deleted = this.trimFrames.run(threadId, record.below, record.open ?? 0).changes;
    if (Number(deleted) < 256)
      this.writeFramesRecord.run(threadId, JSON.stringify({ ...record, trimmed: true }));
  }
}
