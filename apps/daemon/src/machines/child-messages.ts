import type { MachineMessage, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { ChildLedger, ChildRow } from "./child-ledger.ts";

/** How a machine answered for a message: it holds it, or it will never run it. */
export type Answer = "taken" | "refused";

export interface ChildMessagesDeps {
  store: Store;
  ledger: ChildLedger;
  now(): number;
  /**
   * Sends a message again under its own request id, which the machine runs at most once.
   * "taken" or "refused" answers for it; a machine that can't be reached throws.
   */
  resend(
    machine: string,
    parentThreadId: ThreadId,
    child: ThreadId,
    message: MachineMessage,
  ): Promise<"taken" | "refused">;
  /** A settled child given new work: open again, in the transaction that records the work. */
  reopenSettled(row: ChildRow): void;
  /** Its machine took the work: replies read before now no longer apply. */
  reopen(id: ThreadId): void;
  /** Something to poll for may have changed. */
  changed(): void;
  log(message: string, fields: Record<string, unknown>): void;
}

/**
 * Messages to children on other machines, each kept until its machine answers for it. While
 * one is unanswered its child is not settled; it is sent again under the same request id until
 * an answer comes, which its machine gives without running it twice.
 */
export class ChildMessages {
  private deps: ChildMessagesDeps;
  /** Messages this process is sending now, by child and request id: not sent again meanwhile. */
  private inFlight = new Set<string>();
  constructor(deps: ChildMessagesDeps) {
    this.deps = deps;
  }
  /**
   * New work is on its way to the child. It is saved first, with the child reopened, so a caller
   * that stops before the reply finds it open and the message unanswered. Until its machine
   * answers for the message no status reply settles the child, and replies read before now never
   * will. The returned release takes the machine's answer for it: "taken", "refused" (it never
   * runs, or was never reached), or none; an unanswered message is sent again on the next poll.
   */
  send(id: ThreadId, message: MachineMessage): (answer: Answer | undefined) => void {
    const { ledger } = this.deps;
    const key = `${id}:${message.requestId}`;
    this.deps.store.atomic(() => {
      ledger.addMessage(id, message, this.deps.now());
      const row = ledger.row(id);
      if (row?.settled === 1) this.deps.reopenSettled(row);
    });
    this.inFlight.add(key);
    let released = false;
    return (answer) => {
      if (released) return;
      released = true;
      this.inFlight.delete(key);
      if (answer) this.answered(id, message.requestId, answer);
      this.deps.changed();
    };
  }
  /**
   * The machine answered for a message. A message taken advances the child's generation in the
   * same transaction that drops the record, so a status reply read before it can never settle
   * the child once nothing guards it. Should saving fail (a busy store), the record stays and the
   * next poll sends the message again, which its machine answers without running it twice.
   */
  private answered(id: ThreadId, requestId: string, answer: Answer): void {
    try {
      this.deps.store.atomic(() => {
        this.deps.ledger.resolveMessage(id, requestId);
        if (answer === "taken") this.deps.reopen(id);
      });
    } catch (error) {
      this.deps.log("Machine message answer not saved yet", { id, error: String(error) });
    }
  }
  /**
   * Sends every unanswered message not being sent now again, under its own request id. An answer
   * proves the machine holds the message (it runs, or ran) or refused it; one that can't be
   * reached keeps it unanswered, and its child unsettled.
   */
  async reconcile(): Promise<void> {
    const pending = this.deps.ledger
      .messages(16)
      .filter(({ child, message }) => !this.inFlight.has(`${child.id}:${message.requestId}`));
    await Promise.all(
      pending.map(async ({ child, message }) => {
        const key = `${child.id}:${message.requestId}`;
        this.inFlight.add(key);
        try {
          const answer = await this.deps.resend(
            child.machine,
            child.parent_thread,
            child.id,
            message,
          );
          this.answered(child.id, message.requestId, answer);
        } catch (error) {
          this.deps.log("Machine message still unanswered", { id: child.id, error: String(error) });
        } finally {
          this.inFlight.delete(key);
          this.deps.changed();
        }
      }),
    );
  }
}
