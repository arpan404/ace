import { z } from "zod";
import { IncomingTransfer, TransferMethod, TransferSessionOutcome } from "@ace/protocol";
import type { Store } from "../../store.ts";

type Result = NonNullable<IncomingTransfer["result"]>;

/**
 * A moved thread's start on this machine (ADR 0191): how its history came, whether it runs, and
 * the import's result. It is also the receipt a sender's late or repeated call is answered from:
 * the transfer's own row is swept after a day, this one never is, so a lost answer can't make a
 * second thread.
 */
export interface LiveStart {
  transferId: string;
  /** The paired device that sent it: only that device is answered from the receipt. */
  deviceId: string;
  method: TransferMethod;
  threadId: string;
  session: TransferSessionOutcome;
  /** The import's result, as the sender is told it. */
  result: Result;
  /** Unset until the first turn's start is known: running, or shown failed there. */
  running?: boolean | undefined;
  /** Why the turn didn't start, once that is final. */
  failure?: string | undefined;
  /** Attempts at sending the continue message that the engine refused, and the next one's time. */
  attempts: number;
  nextAt: number;
}

const Row = z.object({
  transfer_id: z.string(),
  device_id: z.string(),
  method: TransferMethod,
  thread_id: z.string(),
  session: z.string(),
  result: z.string(),
  running: z.number().nullable(),
  failure: z.string().nullable(),
  attempts: z.number(),
  next_at: z.number(),
});

const decode = (raw: unknown): LiveStart => {
  const row = Row.parse(raw);
  return {
    transferId: row.transfer_id,
    deviceId: row.device_id,
    method: row.method,
    threadId: row.thread_id,
    session: TransferSessionOutcome.parse(JSON.parse(row.session)),
    result: IncomingTransfer.shape.result.unwrap().parse(JSON.parse(row.result)),
    ...(row.running === null ? {} : { running: row.running === 1 }),
    ...(row.failure === null ? {} : { failure: row.failure }),
    attempts: row.attempts,
    nextAt: row.next_at,
  };
};

/** How many pending starts one read returns; recovery reads on until none are left. */
export const pendingBatch = 64;

/**
 * Durable, so a restart between making the thread and its first turn finishes the start. Starts
 * still pending are listed in a table of their own, so finding them never reads the finished
 * ones (ADR 0170): it holds only what a restart has left to do.
 */
export class LiveStarts {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_live_start (
        transfer_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, method TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        session TEXT NOT NULL, result TEXT NOT NULL, running INTEGER, failure TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        at INTEGER NOT NULL)`);
      db.exec("CREATE TABLE IF NOT EXISTS transfer_live_pending (transfer_id TEXT PRIMARY KEY)");
    });
  }
  get(transferId: string): LiveStart | undefined {
    const raw = this.store
      .statement("SELECT * FROM transfer_live_start WHERE transfer_id=?")
      .get(transferId);
    return raw ? decode(raw) : undefined;
  }
  /** The first record wins: a restart never changes how the history came. */
  begin(start: Omit<LiveStart, "attempts" | "nextAt">, at: number): LiveStart {
    this.store.atomic(() => {
      const inserted = this.store
        .statement(
          `INSERT INTO transfer_live_start
          (transfer_id,device_id,method,thread_id,session,result,running,at)
          VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(transfer_id) DO NOTHING`,
        )
        .run(
          start.transferId,
          start.deviceId,
          start.method,
          start.threadId,
          JSON.stringify(start.session),
          JSON.stringify(start.result),
          at,
        );
      if (inserted.changes)
        this.store
          .statement("INSERT OR IGNORE INTO transfer_live_pending (transfer_id) VALUES (?)")
          .run(start.transferId);
    });
    return this.get(start.transferId) ?? { ...start, attempts: 0, nextAt: 0 };
  }
  /** The session fell back to the summary when it failed to open. */
  summary(transferId: string, reason: string, at: number): void {
    this.store
      .statement("UPDATE transfer_live_start SET session=?, at=? WHERE transfer_id=?")
      .run(JSON.stringify({ kind: "summary", reason }), at, transferId);
  }
  /** The engine refused the continue message for now: try again at `nextAt`. */
  deferred(transferId: string, nextAt: number, at: number): void {
    this.store
      .statement(
        "UPDATE transfer_live_start SET attempts=attempts+1, next_at=?, at=? WHERE transfer_id=?",
      )
      .run(nextAt, at, transferId);
  }
  /** The start is known: running, or final with why not. It leaves the pending list. */
  started(transferId: string, running: boolean, at: number, failure?: string): void {
    this.store.atomic(() => {
      this.store
        .statement("UPDATE transfer_live_start SET running=?, failure=?, at=? WHERE transfer_id=?")
        .run(running ? 1 : 0, failure ?? null, at, transferId);
      this.store.statement("DELETE FROM transfer_live_pending WHERE transfer_id=?").run(transferId);
    });
  }
  /** One batch of starts a restart left unfinished, after `after` in id order. */
  unfinished(after = ""): LiveStart[] {
    return this.store
      .statement(
        `SELECT s.* FROM transfer_live_pending p JOIN transfer_live_start s USING (transfer_id)
        WHERE p.transfer_id>? ORDER BY p.transfer_id LIMIT ${pendingBatch}`,
      )
      .all(after)
      .map(decode);
  }
}
