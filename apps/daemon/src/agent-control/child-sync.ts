import {
  type CommandPayload,
  type CommandResult,
  type DelegationPolicy,
  type DelegationRecord,
  type Event,
  type QueueFacts,
  type ThreadId,
} from "@ace/protocol";
import { childStatus, queuedChildStatus } from "./child-status.ts";
import { controlCommandId } from "./command-id.ts";
import type { DelegationDependencies } from "./delegations.ts";
import { threadAccount } from "./failure-account.ts";
import { controlAdmissionError } from "./failure.ts";
import type { DelegationJournal } from "./journal.ts";
import type { LaunchQueue } from "./launch-queue.ts";
import type { LimitNotices } from "./limit-notices.ts";
import { childStoppedOnLimit } from "./limit-settlement.ts";
import { deliveryNotice, type DeliveryNotice } from "./message-notices.ts";
import { threadOutcome } from "./results.ts";
import type { OutcomeWaiters } from "./waiters.ts";

/** What keeping delegated children in step with their threads needs from the service. */
export interface ChildSyncPorts {
  deps: DelegationDependencies;
  journal: DelegationJournal;
  policy: DelegationPolicy;
  launches: LaunchQueue;
  waiters: OutcomeWaiters;
  limits: LimitNotices;
  closed(): boolean;
  now(): number;
  command(id: string, payload: CommandPayload): CommandResult;
  cancelDescendants(thread: ThreadId, request: string): void;
  queueFacts(child: ThreadId): QueueFacts | undefined;
  noticeSender(child: ThreadId, notice: DeliveryNotice): void;
  clearDeliveredNotice(child: ThreadId): void;
  reconcileConversation(thread: ThreadId): void;
  pump(parent: ThreadId): void;
  pumpAll(): void;
  arm(): void;
  report(error: unknown): void;
}

/**
 * Keeps each delegated child's edge in step with its thread: reads the store's events, revives
 * children that run again, and settles the ones that ended (or stopped on a limit nothing will
 * carry on) with their outcome, delivering it to waiters and freeing the parent's slot.
 */
export class ChildSync {
  private ports: ChildSyncPorts;
  constructor(ports: ChildSyncPorts) {
    this.ports = ports;
  }
  observe(events: readonly Event[]) {
    if (this.ports.closed()) return;
    let changed = false;
    let statuses = false;
    for (const event of events) {
      statuses ||= event.payload.type === "thread.updated" && !queueFactsTouch(event);
      const notice = deliveryNotice(event);
      if (notice) this.ports.noticeSender(event.threadId, notice);
      if (event.payload.type === "run.started") this.ports.clearDeliveredNotice(event.threadId);
      // A turn that ends on a limit its provider was already retrying changes no status.
      if (event.payload.type === "run.ended") {
        const ended = this.ports.journal.get(event.threadId);
        if (ended) {
          this.reconcile(ended);
          this.ports.limits.check(ended);
          changed = true;
        }
      }
      if (
        event.payload.type !== "thread.updated" &&
        event.payload.type !== "usage.updated" &&
        event.payload.type !== "run.started" &&
        event.payload.type !== "background_task.updated"
      )
        continue;
      if (
        event.payload.type === "thread.updated" &&
        this.ports.waiters.has(event.threadId) &&
        !this.ports.journal.get(event.threadId)
      ) {
        const thread = this.ports.deps.store.getThread(event.threadId);
        // No edge, so never a cancelling child: the outcome is the thread's own.
        if (thread && ["done", "failed"].includes(thread.status.state))
          this.ports.waiters.deliver(thread.id, threadOutcome(this.ports.deps.store, thread));
      }
      const edge = this.ports.journal.get(event.threadId);
      const participant = this.ports.journal.participant(event.threadId);
      if (!edge && !participant) continue;
      const root = edge?.rootId ?? participant?.root_id;
      if (!root) continue;
      changed = true;
      if (event.payload.type === "run.started") {
        this.ports.deps.store.atomic(() => {
          this.ports.journal.account(root, event);
          if (participant) this.ports.journal.activity(event.threadId, 1);
        });
        if (edge) this.reconcile(edge);
      } else if (event.payload.type === "usage.updated") {
        this.ports.journal.account(root, event);
      } else {
        if (participant) this.ports.reconcileConversation(event.threadId);
        if (edge && turnedLimited(event)) this.explainLimit(edge);
        if (edge) this.reconcile(edge);
        if (edge && event.payload.type === "thread.updated") this.ports.limits.check(edge);
      }
    }
    // Slots also free when admission reopens.
    if (statuses) this.ports.pumpAll();
    if (changed) this.ports.arm();
  }
  policyLoaded(id: ThreadId) {
    const edge = this.ports.closed() ? undefined : this.ports.journal.get(id);
    if (edge)
      try {
        this.reconcile(edge);
        this.ports.limits.check(edge);
        this.ports.arm();
      } catch (error) {
        this.ports.report(error);
      }
  }
  /**
   * Codex can end a turn on systemError and only then say the account hit its usage limit, so
   * the child may already have settled with a bare failure. When the limit is what stopped it,
   * it settles again with that reason: the parent hears it once, in place of a result not yet
   * delivered or after one it already read. Only the change to limited does this, so a restart
   * never reopens children settled long ago.
   */
  private explainLimit(edge: DelegationRecord) {
    const thread = this.ports.deps.store.getThread(edge.childId);
    if (
      !thread ||
      edge.phase !== "settled" ||
      edge.outcome?.outcome !== "failed" ||
      edge.outcome.failure?.code === "usage_limited" ||
      !childStoppedOnLimit(thread, this.ports.deps.engine, this.ports.journal)
    )
      return;
    this.ports.deps.store.atomic(() => this.ports.journal.revive(edge));
  }
  reconcile(edge: DelegationRecord) {
    const thread = this.ports.deps.store.getThread(edge.childId);
    if (!thread) return;
    this.ports.deps.store.atomic(() => {
      const stoppedOnLimit = childStoppedOnLimit(
        thread,
        this.ports.deps.engine,
        this.ports.journal,
      );
      if (
        edge.phase === "settled" &&
        !stoppedOnLimit &&
        !["done", "failed", "new"].includes(thread.status.state)
      ) {
        // Revived work always continues, whatever the counts. Only a cancelled child stays stopped.
        this.ports.journal.revive(edge);
        if (
          this.ports.journal.stopped(edge.childId) ||
          this.ports.journal.ancestorStopped(edge.childId)
        ) {
          const request = controlCommandId(
            edge.childId,
            String(edge.generation),
            "native.interrupt",
          );
          this.ports.cancelDescendants(edge.childId, request);
          const result = this.ports.command(request, {
            type: "thread.interrupt",
            threadId: edge.childId,
            cascade: true,
          });
          if (!result.ok) throw controlAdmissionError(result.error ?? "Interrupt failed");
          edge.phase = "cancelling";
        }
      }
      const shown = {
        ...thread,
        status: this.ports.launches.has(edge.childId)
          ? queuedChildStatus(this.ports.queueFacts(edge.childId))
          : childStatus(edge, thread),
      };
      this.ports.deps.engine.updateChild(
        edge.parentId,
        stoppedOnLimit ? { ...shown, status: { state: "failed" } } : shown,
      );
      if (
        edge.phase === "settled" ||
        (!stoppedOnLimit && !["done", "failed"].includes(thread.status.state))
      ) {
        this.ports.deps.engine.delegationStarted(edge, shown);
        return;
      }
      const account = threadAccount(
        thread,
        this.ports.deps.engine,
        this.ports.deps.accounts,
        this.ports.now(),
      );
      const outcome = threadOutcome(
        this.ports.deps.store,
        thread,
        edge.phase === "cancelling",
        account,
      );
      this.ports.journal.settle(
        edge,
        outcome,
        this.ports.deps.clock.now() + this.ports.policy.coalesceMs,
      );
      this.ports.deps.engine.delegationStarted(edge, {
        ...thread,
        status: childStatus(edge, thread),
      });
      this.ports.waiters.deliver(thread.id, outcome);
      // The settled child's slot goes to the next one waiting.
      this.ports.pump(edge.parentId);
    });
  }
}

/**
 * A touch that rewrites only queue facts: it frees no slot and starts nothing, so a batch of
 * only such touches schedules no pump. Anything else in the batch still pumps as before.
 */
function queueFactsTouch(event: Event): boolean {
  const payload = event.payload;
  return (
    payload.type === "thread.updated" &&
    payload.queuedLaunch !== undefined &&
    payload.queuedLaunch !== null &&
    payload.status === undefined &&
    payload.delegatedBy === undefined
  );
}
/** The event moves the thread's status to limited. */
function turnedLimited(event: Event): boolean {
  return event.payload.type === "thread.updated" && event.payload.status?.state === "limited";
}
