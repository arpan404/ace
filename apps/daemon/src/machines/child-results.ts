import { childResultPrompt } from "@ace/orchestrator";
import { DelegationOutcome, ThreadId, type AgentId, type MachineThreadView } from "@ace/protocol";
import type { Store } from "../store.ts";
import { settledStates } from "../agent-control/watch-view.ts";
import { ChildOutbox } from "./child-outbox.ts";
import type { ChildLedger, ChildRow } from "./child-ledger.ts";
import { digest, outcomeOf } from "./child-views.ts";

/** A child's settled result, as a local child's result reaches its parent. */
export interface SettledChild {
  parentAgentId: AgentId;
  outcome: DelegationOutcome;
}

export interface ChildResultsDeps {
  store: Store;
  ledger: ChildLedger;
  label(machine: string): string;
  /**
   * Hands a settled result or a message notice to the parent; `key` names it once. A result
   * carries `settled`, so the parent records it the way it records a local child's result.
   */
  deliver(parentThreadId: ThreadId, key: string, text: string, settled?: SettledChild): void;
  /** A live wait reads this child, so its result is not woken separately. */
  waiting(id: ThreadId): boolean;
  log(message: string, fields: Record<string, unknown>): void;
}

/**
 * What the parents of children on other machines are owed (results and notices), and handing
 * it to them: each once, never lost, whatever the child does afterwards.
 */
export class ChildResults {
  private deps: ChildResultsDeps;
  private outbox: ChildOutbox;
  constructor(deps: ChildResultsDeps) {
    this.deps = deps;
    this.outbox = new ChildOutbox(deps.store);
  }
  hasUnsent(): boolean {
    return this.outbox.hasUnsent();
  }
  /** A parent's message to the child didn't go in as sent: the parent hears why. */
  notice(row: ChildRow, notice: NonNullable<MachineThreadView["notice"]>): void {
    this.outbox.queue({
      key: `notice:${row.id}:${notice.commandId}:${notice.code}`,
      child: row.id,
      parent: row.parent_thread,
      kind: "notice",
      text: `[ace: ${row.role} on ${this.deps.label(row.machine)}]\n${notice.text}`,
    });
  }
  /**
   * A message sent again was rejected there before it reached the child, and never runs: the
   * parent, told only that its call was lost, hears what became of it.
   */
  rejected(row: ChildRow, requestId: string, reason: string): void {
    this.outbox.queue({
      key: `rejected:${row.id}:${requestId}`,
      child: row.id,
      parent: row.parent_thread,
      kind: "notice",
      text: `[ace: ${row.role} on ${this.deps.label(row.machine)}]\nYour message was not taken there and will not run: ${reason}`,
    });
  }
  /** A wait read the child's result inside a tool call: it is not delivered again. */
  read(id: ThreadId): void {
    this.deps.ledger.markDelivered(id);
    this.outbox.resultsRead(id);
  }
  /**
   * Owes the parent the result a settled view carries. Keyed by the outcome, its settle time and
   * its text alone, so the same settle read again (a notice changed the view, the child was
   * reopened and settled unchanged) is the same entry, while a new settle is a new one.
   */
  queueResult(row: ChildRow, view: MachineThreadView | undefined): void {
    if (!view || !settledStates.has(view.state)) return;
    const outcome = outcomeOf(view.state);
    const result =
      view.result ||
      view.failure?.message ||
      (view.state === "failed" ? "The provider stopped without returning a result." : "");
    const key = `result:${row.id}:${digest(JSON.stringify([outcome, view.elapsedSeconds, result]))}`;
    // The same settle read again after a reopen that ran nothing: its parent already has it, so
    // it is delivered again in the ledger only, and the poll can go quiet.
    if (this.outbox.wasSent(key)) return this.deps.ledger.markResultDelivered(row.id);
    const text = result || "No text result returned.";
    const settled: DelegationOutcome = {
      ...(view.failure ? { failure: view.failure } : {}),
      threadId: row.id,
      outcome,
      result: text.slice(0, resultLimit),
      truncated: view.truncated === true || text.length > resultLimit,
      before: null,
    };
    // The outcome itself is kept, so delivery hands the parent the same result a local child's is.
    this.outbox.queue({
      key,
      child: row.id,
      parent: row.parent_thread,
      kind: "result",
      text: JSON.stringify(settled),
    });
  }
  /**
   * Hands every owed result and notice to its parent, oldest first. Each is marked sent only
   * once the parent took it; one that fails waits for the next poll. A result a live wait is
   * about to read is left for that wait.
   */
  drain(): void {
    for (const entry of this.outbox.unsent()) {
      if (entry.kind === "result" && this.deps.waiting(ThreadId.parse(entry.child))) continue;
      try {
        const parent = ThreadId.parse(entry.parent);
        const key = `${entry.kind}:${digest(entry.key)}`;
        const outcome = entry.kind === "result" ? parseOutcome(entry.text) : undefined;
        const row = outcome && this.deps.ledger.row(entry.child);
        if (outcome) {
          const settled = row ? { parentAgentId: row.parent_agent, outcome } : undefined;
          this.deps.deliver(parent, key, childResultPrompt([outcome]), settled);
        }
        // A notice, or a result queued as plain text before outcomes were kept.
        else this.deps.deliver(parent, key, entry.text);
        this.outbox.sent(entry.key);
        if (entry.kind === "result") this.deps.ledger.markResultDelivered(entry.child);
      } catch (error) {
        this.deps.log("Machine result not delivered yet", {
          id: entry.child,
          error: String(error),
        });
      }
    }
  }
}

/** The longest result a parent is handed, as for a local child. */
const resultLimit = 4096;

function parseOutcome(text: string): DelegationOutcome | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = DelegationOutcome.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
