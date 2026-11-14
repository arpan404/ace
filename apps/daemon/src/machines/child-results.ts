import { childResultPrompt } from "@ace/orchestrator";
import { DelegationOutcome, ThreadId, type AgentId, type MachineThreadView } from "@ace/protocol";
import type { Store } from "../store.ts";
import { settledStates } from "../agent-control/watch-view.ts";
import { ChildOutbox, type OutboxEntry } from "./child-outbox.ts";
import { RetryBackoff } from "./retry-backoff.ts";
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
   * `"gone"`: the parent thread is deleted or never existed, so nothing can ever take it. A throw
   * is a failure that may pass, tried again later.
   */
  deliver(
    parentThreadId: ThreadId,
    key: string,
    text: string,
    settled?: SettledChild,
  ): "gone" | void;
  /**
   * The parent is stopped: like a local child's, its results wait, untried, for its next input
   * (the person or its own parent speaking again), never dropped.
   */
  held?: ((parentThreadId: ThreadId) => boolean) | undefined;
  /** A live wait reads this child, so its result is not woken separately. */
  waiting(id: ThreadId): boolean;
  now(): number;
  log(message: string, fields: Record<string, unknown>): void;
}

/** A failed delivery is tried again after 1 s, doubling, at most a minute apart. */
export const DELIVERY_RETRY_MS = 1000;
export const DELIVERY_RETRY_CAP_MS = 60_000;

/**
 * What the parents of children on other machines are owed (results and notices), and handing
 * it to them: each once, never lost, whatever the child does afterwards.
 */
export class ChildResults {
  private deps: ChildResultsDeps;
  private outbox: ChildOutbox;
  private backoff = new RetryBackoff(DELIVERY_RETRY_MS, DELIVERY_RETRY_CAP_MS);
  /** Entries waiting on a stopped parent, by key, with that parent. */
  private parked = new Map<string, string>();
  /** An entry may be deliverable now: one was queued, a wait holds one, or a parent resumed. */
  private ready: boolean;
  constructor(deps: ChildResultsDeps) {
    this.deps = deps;
    this.outbox = new ChildOutbox(deps.store);
    // After a restart every unsent entry is tried once at once, and every result owed queued.
    this.ready = this.outbox.hasUnsent() || deps.ledger.hasUndelivered();
  }
  /**
   * When the poll should next try to deliver: now when something may be deliverable, else when
   * the soonest failed delivery is due again, undefined while all that is unsent waits on stopped
   * parents (resumed() wakes them) or nothing is.
   */
  wakeAt(now: number): number | undefined {
    if (this.ready) return now;
    return this.backoff.nextDue();
  }
  /** The parent may take what waits for it now (it was resumed): true when something did. */
  resumed(parent: string): boolean {
    let any = false;
    for (const [key, of] of this.parked)
      if (of === parent) {
        any = true;
        this.backoff.retryNow(key);
      }
    if (any) this.ready = true;
    return any;
  }
  private queue(entry: OutboxEntry): void {
    if (this.outbox.queue(entry)) this.ready = true;
  }
  /** A parent's message to the child didn't go in as sent: the parent hears why. */
  notice(row: ChildRow, notice: NonNullable<MachineThreadView["notice"]>): void {
    this.queue({
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
    this.queue({
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
    this.queue({
      key,
      child: row.id,
      parent: row.parent_thread,
      kind: "result",
      text: JSON.stringify(settled),
    });
  }
  /**
   * Hands every owed result and notice to its parent, oldest first. Each is marked sent only
   * once the parent took it. One a stopped parent can't take waits, untried, for that parent to
   * be resumed; one that fails is tried again with backoff, logged when it first fails and when
   * it finally goes. A parent deleted for good ends the entry, recorded once. A result a live
   * wait is about to read is left for that wait.
   */
  drain(): void {
    const now = this.deps.now();
    this.ready = false;
    for (const entry of this.outbox.unsent()) {
      if (entry.kind === "result" && this.deps.waiting(ThreadId.parse(entry.child))) {
        this.ready = true;
        continue;
      }
      const parent = ThreadId.parse(entry.parent);
      if (this.park(entry, parent)) continue;
      if (!this.backoff.due(entry.key, now)) continue;
      this.attempt(entry, parent, now);
    }
  }
  /** True while the entry's parent is stopped; logged once when it starts waiting. */
  private park(entry: OutboxEntry, parent: ThreadId): boolean {
    let held: boolean;
    try {
      held = this.deps.held?.(parent) ?? false;
    } catch {
      // Unreadable now: delivery itself says whether the parent takes it.
      held = false;
    }
    if (!held) {
      this.parked.delete(entry.key);
      return false;
    }
    if (!this.parked.has(entry.key))
      this.deps.log("Machine result waits for its stopped parent", {
        id: entry.child,
        parent: entry.parent,
        kind: entry.kind,
      });
    this.parked.set(entry.key, entry.parent);
    return true;
  }
  private attempt(entry: OutboxEntry, parent: ThreadId, now: number): void {
    try {
      const key = `${entry.kind}:${digest(entry.key)}`;
      const outcome = entry.kind === "result" ? parseOutcome(entry.text) : undefined;
      const row = outcome && this.deps.ledger.row(entry.child);
      let answer: "gone" | void;
      if (outcome) {
        const settled = row ? { parentAgentId: row.parent_agent, outcome } : undefined;
        answer = this.deps.deliver(parent, key, childResultPrompt([outcome]), settled);
      }
      // A notice, or a result queued as plain text before outcomes were kept.
      else answer = this.deps.deliver(parent, key, entry.text);
      this.outbox.sent(entry.key);
      if (entry.kind === "result") this.deps.ledger.markResultDelivered(entry.child);
      const failures = this.backoff.succeeded(entry.key);
      if (answer === "gone")
        this.deps.log("Machine result dropped: its parent thread is gone", {
          id: entry.child,
          parent: entry.parent,
          kind: entry.kind,
          attempts: failures + 1,
        });
      else if (failures > 0)
        this.deps.log("Machine result delivered after failing", {
          id: entry.child,
          attempts: failures + 1,
        });
    } catch (error) {
      if (this.backoff.failed(entry.key, now) === 1)
        this.deps.log("Machine result not delivered yet", {
          id: entry.child,
          error: String(error),
        });
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
