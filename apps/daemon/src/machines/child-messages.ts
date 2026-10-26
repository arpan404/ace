import type { MachineMessage, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { ChildLedger, ChildRow } from "./child-ledger.ts";

/** Retries running at once: across all machines, and on any one machine. */
const MAX_IN_FLIGHT = 16;
const MAX_IN_FLIGHT_PER_MACHINE = 4;
/** The wait before a message's next retry: one second, doubling, at most a minute. */
export function retryDelay(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 60_000);
}

/**
 * How a machine answered for a message. "taken": it holds it. "decided": it recorded a final
 * answer that every copy gets (the message may still be queued there, so this counts as new work
 * like a take). "refused": a first attempt that never reached it or was refused at its gate, so
 * no copy is anywhere and nothing will run.
 */
export type Answer = "taken" | "decided" | "refused";
/**
 * How a machine answered a message sent again: as Answer, or `rejected` when it refused the
 * request before it ever reached the child and recorded that, so no copy of it can ever run
 * there (ADR 0099). The reason is for the parent.
 */
export type ResendAnswer = "taken" | "decided" | { rejected: string };

export interface ChildMessagesDeps {
  store: Store;
  ledger: ChildLedger;
  now(): number;
  /**
   * Sends a message again under its own request id, which the machine runs at most once.
   * Any ResendAnswer answers for it; anything else (a machine that can't be reached, a refusal
   * of this attempt alone) throws, and the message is sent again later.
   */
  resend(
    machine: string,
    parentThreadId: ThreadId,
    child: ThreadId,
    message: MachineMessage,
  ): Promise<ResendAnswer>;
  /** A settled child given new work: open again, in the transaction that records the work. */
  reopenSettled(row: ChildRow): void;
  /** Its machine took the work: replies read before now no longer apply. */
  reopen(id: ThreadId): void;
  /** Something to poll for may have changed. */
  changed(): void;
  /** Why a message to the child is still unanswered after an attempt; undefined once answered. */
  held(child: ChildRow, error: unknown): void;
  /** The machine rejected a message before it reached the child: the parent hears why. */
  rejected(child: ChildRow, requestId: string, reason: string): void;
  log(message: string, fields: Record<string, unknown>): void;
}

/**
 * Messages to children on other machines, each kept until its machine answers for it. While
 * one is unanswered its child is not settled; it is sent again under the same request id until
 * an answer comes, which its machine gives without running it twice.
 */
export class ChildMessages {
  private deps: ChildMessagesDeps;
  /**
   * Messages this process is sending now, by child and request id, with their machine: not sent
   * again meanwhile, and counted against the retry caps.
   */
  private inFlight = new Map<string, string>();
  constructor(deps: ChildMessagesDeps) {
    this.deps = deps;
  }
  /**
   * New work is on its way to the child. It is saved first, with the child reopened, so a caller
   * that stops before the reply finds it open and the message unanswered. Until its machine
   * answers for the message no status reply settles the child, and replies read before now never
   * will. The returned release takes the machine's answer for it (see Answer), or none; an
   * unanswered message is sent again on the next poll.
   */
  send(id: ThreadId, message: MachineMessage): (answer: Answer | undefined) => void {
    const { ledger } = this.deps;
    const key = `${id}:${message.requestId}`;
    const machine = this.deps.store.atomic(() => {
      ledger.addMessage(id, message, this.deps.now());
      const row = ledger.row(id);
      if (row?.settled === 1) this.deps.reopenSettled(row);
      return row?.machine ?? "";
    });
    this.inFlight.set(key, machine);
    let released = false;
    return (answer) => {
      if (released) return;
      released = true;
      this.inFlight.delete(key);
      if (answer) this.answered(id, message.requestId, answer);
      const row = ledger.row(id);
      if (answer && row && !ledger.hasMessages(id)) this.deps.held(row, undefined);
      this.deps.changed();
    };
  }
  /**
   * The machine answered for a message. A message taken, or one it recorded a final answer for,
   * advances the child's generation in the same transaction that drops the record, so a status reply read before it can never settle
   * the child once nothing guards it. Should saving fail (a busy store), the record stays and the
   * next poll sends the message again, which its machine answers without running it twice.
   */
  private answered(id: ThreadId, requestId: string, answer: Answer, rejected?: string): void {
    try {
      this.deps.store.atomic(() => {
        this.deps.ledger.resolveMessage(id, requestId);
        if (answer !== "refused") this.deps.reopen(id);
        const row = rejected === undefined ? undefined : this.deps.ledger.row(id);
        if (row && rejected !== undefined) this.deps.rejected(row, requestId, rejected);
      });
    } catch (error) {
      this.deps.log("Machine message answer not saved yet", { id, error: String(error) });
    }
  }
  /**
   * Sends unanswered messages that are due again, under their own request ids. An answer proves
   * the machine holds the message or recorded a final answer for it; anything else leaves it
   * unanswered, its child unsettled, and its next retry later than the last. Messages being sent
   * now and machines already at their cap are left out before choosing, so one slow or
   * unreachable machine never holds back a message to another.
   */
  async reconcile(): Promise<void> {
    const room = MAX_IN_FLIGHT - this.inFlight.size;
    if (room <= 0) return;
    const perMachine = new Map<string, number>();
    for (const machine of this.inFlight.values())
      perMachine.set(machine, (perMachine.get(machine) ?? 0) + 1);
    const full = [...perMachine]
      .filter(([, count]) => count >= MAX_IN_FLIGHT_PER_MACHINE)
      .map(([machine]) => machine);
    const now = this.deps.now();
    const picked = [];
    for (const entry of this.deps.ledger.dueMessages(now, 64, [...this.inFlight.keys()], full)) {
      if (picked.length >= room) break;
      const count = perMachine.get(entry.child.machine) ?? 0;
      if (count >= MAX_IN_FLIGHT_PER_MACHINE) continue;
      perMachine.set(entry.child.machine, count + 1);
      picked.push(entry);
    }
    await Promise.all(
      picked.map(async ({ child, message, attempts }) => {
        const key = `${child.id}:${message.requestId}`;
        this.inFlight.set(key, child.machine);
        try {
          // Saved before it goes: should this attempt fail, the next waits longer.
          this.deps.ledger.deferMessage(child.id, message.requestId, now + retryDelay(attempts));
          const answer = await this.deps.resend(
            child.machine,
            child.parent_thread,
            child.id,
            message,
          );
          // A rejection proves nothing ran or ever will, so the child is not reopened for it.
          if (typeof answer === "string") this.answered(child.id, message.requestId, answer);
          else this.answered(child.id, message.requestId, "refused", answer.rejected);
          if (!this.deps.ledger.hasMessages(child.id)) this.deps.held(child, undefined);
        } catch (error) {
          this.deps.log("Machine message still unanswered", { id: child.id, error: String(error) });
          // Still waiting, never settled: the parent's agents_status and wait show why.
          this.deps.held(child, error);
        } finally {
          this.inFlight.delete(key);
          this.deps.changed();
        }
      }),
    );
  }
}
