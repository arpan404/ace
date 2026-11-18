import { z } from "zod";
import { TransferSessionOutcome } from "@ace/protocol";
import type { Store } from "../../store.ts";

/** A moved thread's start on this machine (ADR 0191): how its history came, and whether it runs. */
export interface LiveStart {
  transferId: string;
  threadId: string;
  session: TransferSessionOutcome;
  /** Unset until the first turn's start is known: running, or shown failed there. */
  running?: boolean | undefined;
}

const Row = z.object({
  transfer_id: z.string(),
  thread_id: z.string(),
  session: z.string(),
  running: z.number().nullable(),
});

/** Durable, so a restart between making the thread and its first turn finishes the start. */
export class LiveStarts {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_live_start (
        transfer_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session TEXT NOT NULL,
        running INTEGER, at INTEGER NOT NULL)`),
    );
  }
  get(transferId: string): LiveStart | undefined {
    const raw = this.store
      .statement("SELECT * FROM transfer_live_start WHERE transfer_id=?")
      .get(transferId);
    if (!raw) return undefined;
    const row = Row.parse(raw);
    return {
      transferId: row.transfer_id,
      threadId: row.thread_id,
      session: TransferSessionOutcome.parse(JSON.parse(row.session)),
      ...(row.running === null ? {} : { running: row.running === 1 }),
    };
  }
  /** The first record wins: a restart never changes how the history came. */
  begin(start: LiveStart, at: number): LiveStart {
    this.store
      .statement(
        "INSERT INTO transfer_live_start (transfer_id,thread_id,session,running,at) VALUES (?,?,?,NULL,?) ON CONFLICT(transfer_id) DO NOTHING",
      )
      .run(start.transferId, start.threadId, JSON.stringify(start.session), at);
    return this.get(start.transferId) ?? start;
  }
  /** The session fell back to the summary when it failed to open. */
  summary(transferId: string, reason: string, at: number): void {
    this.store
      .statement("UPDATE transfer_live_start SET session=?, at=? WHERE transfer_id=?")
      .run(JSON.stringify({ kind: "summary", reason }), at, transferId);
  }
  started(transferId: string, running: boolean, at: number): void {
    this.store
      .statement("UPDATE transfer_live_start SET running=?, at=? WHERE transfer_id=?")
      .run(running ? 1 : 0, at, transferId);
  }
  /** Starts a restart left unfinished. */
  unfinished(): LiveStart[] {
    return this.store
      .statement("SELECT * FROM transfer_live_start WHERE running IS NULL LIMIT 64")
      .all()
      .map((raw) => {
        const row = Row.parse(raw);
        return {
          transferId: row.transfer_id,
          threadId: row.thread_id,
          session: TransferSessionOutcome.parse(JSON.parse(row.session)),
        };
      });
  }
}
