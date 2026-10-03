import { createHash } from "node:crypto";
import { admitDelegation, delegationBudget, childResultPrompt } from "@ace/orchestrator";
import { pickInstance, type AccountRegistry } from "@ace/accounts";
import { AccountProvider } from "@ace/protocol/accounts";
import {
  Command,
  ThreadId,
  DelegationPolicy,
  DelegationRequest,
  type DelegationRecord,
  type WorkspaceId,
  type McpAttribution,
  type Event,
  type DelegationOutcome,
  type CommandPayload,
} from "@ace/protocol";
import type { Engine, EngineClock } from "../engine/index.ts";
import type { Store } from "../store.ts";
import { commandContext } from "../commands.ts";
import { OutcomeWaiters } from "./waiters.ts";
import { DelegationJournal } from "./journal.ts";
import { threadOutcome } from "./results.ts";

export interface DelegationDependencies {
  store: Store;
  engine: Engine;
  clock: EngineClock;
  id(): string;
  accounts?: AccountRegistry;
  policy?: Partial<DelegationPolicy>;
  onError(error: unknown): void;
  /** The daemon maintenance gate remains the owner of autonomous turn admission. */
  admitsWork?(): boolean;
}
export function controlCommandId(thread: string, request: string, operation: string) {
  return `agent-${createHash("sha256")
    .update(JSON.stringify([thread, request, operation]))
    .digest("hex")}`;
}
/** Durable execution owner shared by agent tools and Deck, independent of MCP transport. */
export class DelegationService {
  readonly journal: DelegationJournal;
  readonly policy: DelegationPolicy;
  private deps: DelegationDependencies;
  private unsubscribe: () => void;
  private cancelTimer: (() => void) | undefined;
  private closed = false;
  private waiters = new OutcomeWaiters();
  constructor(deps: DelegationDependencies) {
    this.deps = deps;
    this.policy = DelegationPolicy.parse(deps.policy ?? {});
    this.journal = new DelegationJournal(deps.store);
    this.unsubscribe = deps.store.subscribe((events) => this.observe(events));
    // Recovery visits current work only, never transcript history or old receipts.
    for (const edge of this.journal.active()) this.reconcile(edge);
    this.arm();
  }
  private identity(caller: McpAttribution) {
    const thread = this.deps.store.getThread(caller.threadId);
    if (!thread || !this.deps.store.getMcpAgent(caller.threadId, caller.agentId))
      throw new Error("Forbidden caller");
    return thread;
  }
  authorize(caller: McpAttribution, target: ThreadId, write: boolean): boolean {
    const source = this.identity(caller);
    const thread = this.deps.store.getThread(target);
    return (
      !!thread &&
      (thread.workspaceId === source.workspaceId ||
        (this.journal.get(target)?.rootId ?? target) ===
          (this.journal.get(caller.threadId)?.rootId ?? caller.threadId)) &&
      (!write || target === caller.threadId || this.journal.isDescendant(target, caller.threadId))
    );
  }
  canFork(threadId: ThreadId) {
    const thread = this.deps.store.getThread(threadId);
    return !!thread && this.deps.engine.capabilities(thread.provider).fork;
  }
  command(id: string, payload: CommandPayload) {
    const command = Command.parse({ id, deviceId: "ace-agent", payload });
    return this.deps.store.recordCommand(command.id, command.deviceId, () =>
      this.deps.engine.handler.handle(command, commandContext(this.deps.store)),
    );
  }
  /** A receipt reserves each follow-up generation once, including retries after completion. */
  message(
    caller: McpAttribution,
    requestId: string,
    threadId: ThreadId,
    text: string,
    delivery: "queue" | "steer",
  ) {
    if (
      !this.authorize(caller, threadId, true) ||
      this.closed ||
      this.deps.admitsWork?.() === false
    )
      throw new Error("Forbidden message");
    const command = Command.parse({
      id: controlCommandId(caller.threadId, requestId, "thread.message"),
      deviceId: "ace-agent",
      payload: {
        type: "thread.send",
        threadId,
        input: [{ type: "text", text }],
        delivery,
        trigger: "parent_agent",
      },
    });
    const result = this.deps.store.recordCommand(command.id, command.deviceId, () => {
      const edge = this.journal.get(threadId);
      if (edge?.phase === "cancelling") throw new Error("cancelled");
      if (edge?.phase === "settled") {
        const tree = this.journal.tree(edge.parentId, this.deps.clock.now());
        const rejection = tree.cancelled
          ? "cancelled"
          : delegationBudget(tree, this.policy, this.deps.clock.now());
        if (
          rejection ||
          this.journal.concurrent(edge.parentId) >= this.policy.maxConcurrent ||
          this.journal.activeCount() >= 64
        )
          throw new Error(rejection ?? "concurrency_limit");
      }
      const accepted = this.deps.engine.handler.handle(command, commandContext(this.deps.store));
      if (accepted.ok && edge?.phase === "settled") {
        this.journal.reopen(edge);
        const child = this.deps.store.getThread(threadId);
        if (child)
          this.deps.engine.updateChild(edge.parentId, {
            ...child,
            status: { state: "waiting", on: "queue" },
          });
      }
      return accepted;
    });
    this.arm();
    return result;
  }
  prepare(caller: McpAttribution, value: DelegationRequest): DelegationRecord {
    return this.prepareInWorkspace(caller, value, this.identity(caller).workspaceId);
  }
  /** Host-only workspace selection for Deck/worktree owners; never exposed as tool input. */
  prepareInWorkspace(
    caller: McpAttribution,
    value: DelegationRequest,
    workspace: WorkspaceId,
  ): DelegationRecord {
    if (this.closed || this.deps.admitsWork?.() === false) throw new Error("Admission closed");
    const input = DelegationRequest.parse(value);
    const parent = this.identity(caller);
    return this.deps.store.atomic(() => {
      const receipt = this.journal.receipt(parent.id, input.requestId);
      if (receipt) {
        if (
          receipt.parentAgentId !== caller.agentId ||
          JSON.stringify(receipt.request) !== JSON.stringify(input)
        )
          throw new Error("Request identity conflict");
        return receipt;
      }
      const now = this.deps.clock.now();
      const tree = this.journal.tree(parent.id, now);
      if (this.journal.get(parent.id)?.phase === "cancelling") throw new Error("cancelled");
      const rejection = admitDelegation(
        { ...tree, concurrent: this.journal.concurrent(parent.id) },
        this.policy,
        now,
      );
      if (rejection || this.journal.activeCount() >= 64)
        throw new Error(rejection ?? "active_limit");
      const provider = AccountProvider.safeParse(input.provider);
      const candidates = provider.success
        ? (this.deps.accounts
            ?.list()
            .filter(
              (entry) =>
                entry.instance.provider === provider.data &&
                (!input.accountId || entry.instance.id === input.accountId),
            ) ?? [])
        : [];
      const selected = provider.success
        ? pickInstance(
            { provider: provider.data, role: input.role, estimatedLoad: input.estimatedLoad },
            candidates,
            now,
          )
        : undefined;
      if ((input.accountId || candidates.length > 0) && !selected)
        throw new Error("Account unavailable or quota exhausted");
      const childId = ThreadId.parse(this.deps.id());
      const result = this.command(controlCommandId(parent.id, input.requestId, "create"), {
        type: "thread.prepare",
        threadId: childId,
        workspaceId: workspace,
        provider: input.provider,
        title: input.role.slice(0, 256),
        ...(input.model ? { model: input.model } : {}),
        ...(input.options ? { options: input.options } : {}),
        ...(selected ? { accountId: selected.id } : {}),
      });
      if (!result.ok) throw new Error(result.error);
      const child = this.deps.store.getThread(childId);
      if (!child) throw new Error("Child creation failed");
      const record: DelegationRecord = {
        childId,
        parentId: parent.id,
        parentAgentId: caller.agentId,
        rootId: tree.root,
        requestId: input.requestId,
        request: input,
        depth: tree.depth + 1,
        createdAt: now,
        phase: "created",
        generation: 0,
      };
      this.journal.add(record);
      this.deps.engine.attachChild(parent.id, caller.agentId, child, input.role, !input.wait);
      this.arm();
      return record;
    });
  }
  delegate(caller: McpAttribution, value: DelegationRequest): DelegationRecord {
    return this.deps.store.atomic(() => {
      const record = this.prepare(caller, value);
      this.launch(record, `Role: ${record.request.role}\n\nTask:\n${record.request.task}`);
      return record;
    });
  }
  launch(record: DelegationRecord, text: string): void {
    this.deps.store.atomic(() => {
      const current = this.journal.get(record.childId);
      if (!current || current.phase !== "created") return;
      const result = this.command(controlCommandId(current.parentId, current.requestId, "launch"), {
        type: "thread.send",
        threadId: current.childId,
        input: [{ type: "text", text }],
        delivery: "queue",
        trigger: "spawn",
      });
      if (!result.ok) throw new Error(result.error);
      current.phase = "running";
      this.journal.save(current);
    });
  }
  cancelDescendants(thread: ThreadId) {
    this.deps.store.atomic(() => {
      const tree = this.journal.tree(thread, this.deps.clock.now());
      this.journal.cancel(thread);
      const own = this.journal.get(thread);
      if (own && own.phase !== "settled") {
        own.phase = "cancelling";
        this.journal.save(own);
      }
      const children = this.journal
        .family(tree.root)
        .filter(
          (edge) => edge.phase !== "settled" && this.journal.isDescendant(edge.childId, thread),
        )
        .toSorted((a, b) => b.depth - a.depth);
      for (const child of children) {
        child.phase = "cancelling";
        this.journal.save(child);
        const result = this.command(controlCommandId(child.childId, "cascade", "interrupt"), {
          type: "thread.interrupt",
          threadId: child.childId,
          cascade: true,
        });
        if (!result.ok) throw new Error(result.error);
      }
    });
  }
  private observe(events: readonly Event[]) {
    if (this.closed) return;
    let changed = false;
    for (const event of events) {
      if (
        event.payload.type !== "thread.updated" &&
        event.payload.type !== "usage.updated" &&
        event.payload.type !== "run.started"
      )
        continue;
      if (event.payload.type === "thread.updated" && this.waiters.has(event.threadId)) {
        const thread = this.deps.store.getThread(event.threadId);
        if (thread && ["done", "failed"].includes(thread.status.state)) {
          const outcome = threadOutcome(
            this.deps.store,
            thread,
            this.journal.get(thread.id)?.phase === "cancelling",
          );
          this.waiters.deliver(thread.id, outcome);
        }
      }
      const edge = this.journal.get(event.threadId);
      if (!edge) continue;
      changed = true;
      if (event.payload.type === "run.started") {
        if (edge) this.deps.store.atomic(() => this.journal.started(event));
      } else if (event.payload.type === "usage.updated" && edge) {
        this.deps.store.atomic(() => this.journal.usage(edge.rootId, event));
        const tree = this.journal.tree(edge.rootId, this.deps.clock.now());
        if (delegationBudget(tree, this.policy, this.deps.clock.now()))
          this.cancelDescendants(edge.rootId);
      } else if (edge) this.reconcile(edge);
    }
    if (changed) this.arm();
  }
  private reconcile(edge: DelegationRecord) {
    const thread = this.deps.store.getThread(edge.childId);
    if (!thread) return;
    this.deps.store.atomic(() => {
      this.deps.engine.updateChild(edge.parentId, thread);
      if (edge.phase === "settled" || !["done", "failed"].includes(thread.status.state)) return;
      const outcome = threadOutcome(this.deps.store, thread, edge.phase === "cancelling");
      this.journal.settle(edge, outcome, this.deps.clock.now() + this.policy.coalesceMs);
      this.waiters.deliver(thread.id, outcome);
    });
  }
  async wait(
    caller: McpAttribution,
    threadId: ThreadId,
    signal: AbortSignal,
  ): Promise<DelegationOutcome> {
    signal.throwIfAborted();
    if (!this.authorize(caller, threadId, false)) throw new Error("Forbidden thread");
    const thread = this.deps.store.getThread(threadId);
    if (!thread) throw new Error("Unknown thread");
    if (["done", "failed"].includes(thread.status.state))
      return this.journal.get(threadId)?.outcome ?? threadOutcome(this.deps.store, thread);
    return this.waiters.wait(threadId, signal);
  }
  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.closed) return;
    const next = this.journal.nextWake();
    const expiry = this.journal.nextExpiry();
    const at = Math.min(
      next?.due ?? Infinity,
      expiry ? expiry.started_at + this.policy.durationMs : Infinity,
    );
    if (at === Infinity) return;
    this.cancelTimer = this.deps.clock.setTimer(
      () => {
        this.cancelTimer = undefined;
        try {
          this.drain();
        } catch (error) {
          const retry = this.journal.nextWake();
          if (retry) this.journal.deferWake(retry.parent_id, this.deps.clock.now() + 1000);
          this.deps.onError(error);
        }
        this.arm();
      },
      Math.max(0, at - this.deps.clock.now()),
    );
  }
  /** Deterministic timer boundary also used by Deck's scheduler. Never executes provider I/O. */
  drain() {
    if (this.closed) return;
    for (let limit = 0; limit < 64; limit++) {
      const expiry = this.journal.nextExpiry();
      if (!expiry || expiry.started_at + this.policy.durationMs > this.deps.clock.now()) break;
      this.cancelDescendants(expiry.root_id);
    }
    for (let batch = 0; batch < 64; batch++) {
      const next = this.journal.nextWake();
      if (!next || next.due > this.deps.clock.now()) break;
      this.deps.store.atomic(() => {
        const parent = this.deps.store.getThread(next.parent_id);
        const tree = this.journal.tree(next.parent_id, this.deps.clock.now());
        const pending = this.journal.pending(next.parent_id);
        const cancelled =
          tree.cancelled || this.journal.get(next.parent_id)?.phase === "cancelling";
        if (!parent || cancelled) {
          this.journal.consume(next.parent_id);
          return;
        }
        if (this.deps.admitsWork?.() === false) {
          this.journal.deferWake(next.parent_id, this.deps.clock.now() + 1000);
          return;
        }
        const results = pending.flatMap((edge) => (edge.outcome ? [edge.outcome] : []));
        if (!results.length) {
          this.journal.consume(next.parent_id);
          return;
        }
        const id = controlCommandId(
          next.parent_id,
          pending.map((edge) => `${edge.childId}:${edge.generation}`).join(","),
          "wake",
        );
        const result = this.command(id, {
          type: "thread.send",
          threadId: next.parent_id,
          input: [{ type: "text", text: childResultPrompt(results) }],
          delivery: "queue",
          trigger: "subagent_result",
        });
        if (!result.ok) throw new Error(result.error);
        this.journal.consume(next.parent_id);
      });
    }
  }
  close() {
    this.closed = true;
    this.waiters.close();
    this.unsubscribe();
    this.cancelTimer?.();
  }
}
