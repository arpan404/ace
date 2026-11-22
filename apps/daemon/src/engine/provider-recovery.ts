import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, Translator } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { sessionStoreUnusable } from "@ace/provider-kit/open-error";
import { cursorStoreUnusable } from "@ace/adapter-cursor/store-fence";
import {
  UnsettledRuns,
  noteAttempt,
  type AttemptRecord,
  type Unsettled,
} from "@ace/adapter-cursor/unsettled";
import type { Store } from "../store.ts";
import { storedAttemptRecord, storedAttemptRecords, storedFramesRecord } from "../stored-decode.ts";

const CapturedFrame = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.literal("sdk"),
  data: z.unknown(),
});

const HostFence = z.object({
  kind: z.literal("error"),
  body: z.object({
    code: z.enum(["boundary_overflow", "checkpoint_budget"]),
    message: z.string().max(4096).optional().catch(undefined),
  }),
});
/** The saved session can never be opened again: the engine hands off instead (ADR 0211). */
/** The threads the idle sweep visits, a few at a time. */
export const idleSweepQuery = "SELECT thread_id FROM engine_cursor_prune LIMIT ?";
/** How many of an earlier build's newest frames its first reopen reads (ADR 0170). */
const legacyWindow = 4096;
/** An earlier build's thread with no send among the frames read and older ones past them. */
const olderRecord: AttemptRecord = { commandId: "", operationId: "", evidence: true, older: true };
const unusable = (message: string) =>
  Object.assign(new Error(message), { code: sessionStoreUnusable });

/** One prepared cursor owner; updates share the transaction that commits canonical facts. */
export class ProviderRecovery {
  private store: Store;
  private readFrames: StatementSync;
  private readRecord: StatementSync;
  private writeRecord: StatementSync;
  private readFramesRecord: StatementSync;
  private writeFramesRecord: StatementSync;
  private trimFrames: StatementSync;
  private readFrame: StatementSync;
  private lastFrame: StatementSync;
  private readRetired: StatementSync;
  private writeRetired: StatementSync;
  private recentKinds: StatementSync;
  private untrimmed: StatementSync;
  private markPrune: StatementSync;
  private clearPrune: StatementSync;
  constructor(store: Store) {
    this.store = store;
    // Threads with settled frames still to delete: the idle sweep's set, small and keyed, so
    // finding them never reads every thread's records (ADR 0170). An empty table to create.
    [this.markPrune, this.clearPrune] = store.atomic((db) => {
      db.exec("CREATE TABLE IF NOT EXISTS engine_cursor_prune(thread_id TEXT PRIMARY KEY)");
      return [
        db.prepare("INSERT OR IGNORE INTO engine_cursor_prune VALUES (?)"),
        db.prepare("DELETE FROM engine_cursor_prune WHERE thread_id=?"),
      ];
    });
    [
      this.readFrames,
      this.readRecord,
      this.writeRecord,
      this.readFramesRecord,
      this.writeFramesRecord,
      this.trimFrames,
      this.readFrame,
      this.lastFrame,
      this.readRetired,
      this.recentKinds,
      this.untrimmed,
      this.writeRetired,
    ] = store.atomic(
      (db) =>
        [
          // A seek on the thread's index from the open turn's first frame on, never a filter.
          db.prepare(
            "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT 8",
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
          db.prepare(
            "SELECT rowid,frame FROM engine_provider_frames WHERE thread_id=? AND rowid=?",
          ),
          db.prepare("SELECT MAX(rowid) AS last FROM engine_provider_frames WHERE thread_id=?"),
          db.prepare(
            "SELECT value FROM engine_state_records WHERE thread_id=? AND section='cursorRetired' AND key='root'",
          ),
          // Newest first, bounded (one past the window, to tell whether older frames exist):
          // where an earlier build's open turn and session start, and what its send's record is.
          db.prepare(
            `SELECT rowid, json_extract(frame,'$.data.kind') AS kind, json_extract(frame,'$.data.operationId') AS operationId, json_extract(frame,'$.data.commandId') AS commandId, json_extract(frame,'$.data.body.admitted') AS admitted, json_extract(frame,'$.data.body.commandId') AS admittedCommand FROM engine_provider_frames WHERE thread_id=? ORDER BY rowid DESC LIMIT ${legacyWindow + 1}`,
          ),
          // Threads whose settled frames are still waiting to be deleted, a few at a time.
          db.prepare(idleSweepQuery),
          db.prepare(
            "INSERT INTO engine_state_records VALUES (?,'cursorRetired','root',?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value",
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
    // An earlier build's thread has no records yet: its first reopen finds where its open turn
    // starts among the newest frames, and from then on it is this build's (`migrate`).
    if (this.legacy(threadId, this.record(threadId))) this.migrate(threadId);
    // The latest session's open frame, read by its row when the open turn began after it, then
    // the open turn's frames: frames of settled turns still waiting to be deleted are not read.
    const { below = 0, open } = this.frames(threadId);
    const opened =
      open !== undefined && open < below
        ? this.store.atomic(() => this.readFrame.get(threadId, open))
        : undefined;
    let rowid = Math.max(0, below - 1);
    let first = opened ? [opened] : undefined;
    do {
      const rows = first ?? this.store.atomic(() => this.readFrames.all(threadId, rowid));
      first = undefined;
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
      // After the open frame, on from the open turn's first frame.
      rowid = Math.max(rowid, below - 1);
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
  /**
   * The records of an earlier build's thread, from its newest frames only (bounded): its open
   * turn starts at its latest send, and its session's open frame is the latest before that. Its
   * attempt record is rebuilt from the same rows and written with the boundary, in one
   * transaction, so a crash never leaves the boundary without the record. With no send among
   * them but older frames past them, a send can't be ruled out: the record says so, and any
   * send in doubt is then held as attempted, never sent again (`older`).
   */
  private migrate(threadId: ThreadId): void {
    this.store.atomic(() => {
      const rows = this.recentKinds.all(threadId);
      const older = rows.length > legacyWindow;
      const recent = rows.slice(0, legacyWindow);
      const sent = recent.findIndex((row) => row.kind === "send");
      const opened = recent.findIndex((row, index) => index > sent && row.kind === "open");
      const start = sent >= 0 ? sent : recent.length - 1;
      let record: AttemptRecord | undefined = older && sent < 0 ? olderRecord : undefined;
      for (const row of recent.slice(0, sent + 1).toReversed())
        record = noteAttempt(record, {
          kind: row.kind,
          operationId: row.operationId,
          ...(row.commandId ? { commandId: row.commandId } : {}),
          body: { admitted: row.admitted === 1, commandId: row.admittedCommand ?? undefined },
        });
      const first = recent[start];
      if (!first) return;
      const below = Number(first.rowid);
      const openRow = sent >= 0 ? recent[opened] : undefined;
      const open = openRow ? Number(openRow.rowid) : undefined;
      if (record) this.writeRecord.run(threadId, JSON.stringify(record));
      this.writeFrames(threadId, {
        below,
        ...(open === undefined ? {} : { open }),
        trimmed: false,
      });
    });
  }
  /** Sends of retired sessions, with their delivery evidence (see `reset`). */
  private retired(threadId: ThreadId): AttemptRecord[] {
    const row = this.store.atomic(() => this.readRetired.get(threadId));
    return row ? storedAttemptRecords(String(row.value)) : [];
  }
  /** Frames an earlier build stored, with none of this build's records: only then are they searched. */
  private legacy(threadId: ThreadId, record: AttemptRecord | undefined): boolean {
    return !record && this.frames(threadId).below === undefined && !this.retired(threadId).length;
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
    const record = this.current(threadId);
    if (record?.commandId === commandId) return true;
    if (this.retired(threadId).some((kept) => kept.commandId === commandId)) return true;
    // An earlier build's send past the frames it kept can't be ruled out.
    return record?.older === true;
  }
  /**
   * The newest admission a reopened Cursor host read back from its store, if any: whether Cursor
   * ever had the send the daemon saw attempted (ADR 0043, amendment of 2026-11-22).
   */
  lastAdmission(threadId: ThreadId): { commandId?: string; admitted: boolean } | undefined {
    const record = this.current(threadId);
    return record?.admitted === undefined
      ? undefined
      : { commandId: record.commandId, admitted: record.admitted };
  }
  /** The command of the latest send the host attempted, if one is on record. */
  attemptedCommand(threadId: ThreadId): string | undefined {
    const record = this.current(threadId);
    return record?.commandId || undefined;
  }
  /** True when anything of `commandId`'s send beyond the attempt itself was recorded. */
  admissionRecorded(threadId: ThreadId, commandId: string): boolean {
    const record = this.current(threadId);
    if (record?.commandId === commandId) return record.evidence;
    // A retired session's send: only it could have had it, and it is gone. Never re-sent.
    if (this.retired(threadId).some((kept) => kept.commandId === commandId)) return true;
    // Nor is an earlier build's send whose frames are past the newest it kept.
    return record?.older === true;
  }
  /** The attempt record, an earlier build's thread's first rebuilt from its newest frames. */
  private current(threadId: ThreadId): AttemptRecord | undefined {
    const record = this.record(threadId);
    if (!this.legacy(threadId, record)) return record;
    this.migrate(threadId);
    return this.record(threadId);
  }
  /**
   * Forgets a session's frames (and an earlier build's boundary cursor): the thread's next
   * session starts fresh. Its frames are set aside at once (restore reads none of them) and
   * deleted a bounded batch per later commit, never all in one (ADR 0170).
   */
  reset(threadId: ThreadId): void {
    this.store.atomic(() => {
      // A send the retired session may have had keeps its evidence, apart from its frames.
      const record = this.record(threadId);
      if (record) {
        const kept = [...this.retired(threadId), record].slice(-16);
        this.writeRetired.run(threadId, JSON.stringify(kept));
      }
      const last = Number(this.lastFrame.get(threadId)?.last ?? 0);
      this.writeFrames(threadId, { below: last + 1, trimmed: false });
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
    this.writeFrames(threadId, next);
  }
  /**
   * One bounded step of the idle sweep: a batch of settled frames for each of a few threads, so
   * a thread that stays idle still loses its backlog, off any commit (ADR 0170).
   */
  pruneIdle(threads = 4): void {
    const ids = this.store.atomic(() => this.untrimmed.all(threads));
    for (const row of ids) this.store.atomic(() => this.trimStep(ThreadId.parse(row.thread_id)));
  }
  /** Deletes up to 256 frames of settled turns: a bounded step, in the commit it rides on. */
  trimStep(threadId: ThreadId): void {
    const record = this.frames(threadId);
    // Nothing left to delete (or the thread is gone): it leaves the sweep's set.
    if (record.below === undefined || record.trimmed) {
      this.clearPrune.run(threadId);
      return;
    }
    const deleted = this.trimFrames.run(threadId, record.below, record.open ?? 0).changes;
    if (Number(deleted) < 256) this.writeFrames(threadId, { ...record, trimmed: true });
  }
  /** Writes where the thread's frames stand, and whether the sweep still has frames to delete. */
  private writeFrames(
    threadId: ThreadId,
    record: { open?: number; below?: number; trimmed?: boolean },
  ): void {
    this.writeFramesRecord.run(threadId, JSON.stringify(record));
    if (record.trimmed === false) this.markPrune.run(threadId);
    else if (record.trimmed === true) this.clearPrune.run(threadId);
  }
}
