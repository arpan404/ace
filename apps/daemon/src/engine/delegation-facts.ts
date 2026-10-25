import { CommandId } from "@ace/protocol";
import type {
  AgentId,
  DelegationOutcome,
  DelegationRecord,
  ProviderKind,
  Thread,
  ThreadId,
  ThreadStatus,
} from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { EngineClock } from "./actor.ts";

/** The rows a parent thread shows for the children it delegated to, on this or another machine. */
export class DelegationFacts {
  private repo: EngineRepository;
  private clock: EngineClock;
  private wake: (id: ThreadId) => void;
  constructor(repo: EngineRepository, clock: EngineClock, wake: (id: ThreadId) => void) {
    this.repo = repo;
    this.clock = clock;
    this.wake = wake;
  }
  /**
   * A child on another paired machine (ADR 0078): its launch row names the machine, and a
   * background hold keeps the parent from reading done while the child works there.
   */
  machineChild(
    child: {
      id: ThreadId;
      parentId: ThreadId;
      parentAgentId: AgentId;
      machine: string;
      name: string;
      provider: ProviderKind;
      model?: string | undefined;
      role: string;
      title: string;
      status: ThreadStatus;
      outcome: DelegationOutcome | null;
    },
    hold: "start" | "end" | undefined,
  ): void {
    const state = this.repo.requireState(child.parentId);
    const agent = state.indexes.agentKeysById[child.parentAgentId];
    if (!agent) throw new Error("Unknown machine delegation parent");
    const task = `ace-machine:${child.id}`;
    const settled = child.outcome !== null;
    const now = this.clock.now();
    this.repo.apply(
      child.parentId,
      [
        {
          type: "item.upsert",
          agent,
          item: `ace-delegation:${child.id}`,
          draft: {
            type: "delegation.started",
            origin: "ace",
            childThreadId: child.id,
            provider: child.provider,
            ...(child.model ? { model: child.model } : {}),
            title: child.title,
            role: child.role,
            phase: settled ? "settled" : "running",
            status: child.status,
            updatedAt: now,
            generation: 0,
            complete: settled,
            outcome: child.outcome,
            machine: { machine: child.machine, name: child.name },
          },
        },
        ...(hold === "start"
          ? [
              {
                type: "background.started" as const,
                owner: "ace" as const,
                agent,
                task,
                kind: "subagent" as const,
                title: `${child.role} · ${child.name}`,
                stoppable: true,
              },
            ]
          : hold === "end"
            ? [
                {
                  type: "background.ended" as const,
                  task,
                  status:
                    child.outcome?.outcome === "completed"
                      ? ("completed" as const)
                      : child.outcome?.outcome === "cancelled"
                        ? ("stopped" as const)
                        : ("failed" as const),
                },
              ]
            : []),
      ],
      now,
    );
    if (hold === "end") this.wake(child.parentId);
  }
  /** One stable parent item follows each independently owned child thread. */
  delegationStarted(record: DelegationRecord, child: Thread) {
    const state = this.repo.requireState(record.parentId);
    const agent = state.indexes.agentKeysById[record.parentAgentId];
    if (!agent) throw new Error("Unknown delegation parent");
    const selection = this.repo.session(child.id);
    const queue = child.queuedLaunch;
    this.repo.apply(
      record.parentId,
      [
        {
          type: "item.upsert",
          agent,
          item: `ace-delegation:${child.id}`,
          draft: {
            type: "delegation.started",
            origin: "ace",
            childThreadId: child.id,
            provider: child.provider,
            ...(selection.model ? { model: selection.model } : {}),
            ...(selection.instanceId ? { accountId: selection.instanceId } : {}),
            title: child.title,
            role: record.request.role,
            phase: record.phase,
            status: child.status,
            // A queued child's place, so the parent's row can say where it stands.
            ...(queue?.slotLimit !== undefined &&
            queue?.slotsInUse !== undefined &&
            queue?.queuePosition !== undefined
              ? {
                  slotLimit: queue.slotLimit,
                  slotsInUse: queue.slotsInUse,
                  queuePosition: queue.queuePosition,
                }
              : {}),
            updatedAt: this.clock.now(),
            generation: record.generation,
            complete: record.phase === "settled",
            outcome: record.outcome ?? null,
          },
        },
      ],
      this.clock.now(),
    );
  }
  /** Host-only result attribution; ordinary wire sends cannot impersonate ace. */
  delegationSettled(
    parentId: ThreadId,
    parentAgentId: AgentId,
    commandId: string,
    results: DelegationOutcome[],
    delivery: "tool" | "ace-input",
    text?: string,
  ) {
    const state = this.repo.requireState(parentId);
    const agent = state.indexes.agentKeysById[parentAgentId];
    if (!agent) throw new Error("Unknown delegation parent");
    const item = `ace-results:${commandId}`;
    const summaries = results.map((result) => ({
      ...result,
      result: result.result.slice(0, 128),
      truncated: result.truncated || result.result.length > 128,
    }));
    this.repo.store.atomic(() => {
      if (text) {
        this.repo.inputs.register(parentId, `input:${commandId}`, [{ type: "text", text }], {
          kind: "subagent_result",
          commandId: CommandId.parse(commandId),
          threadIds: results.map((result) => result.threadId),
        });
        this.repo.aceInputs.record(parentId, commandId, { agent, item, results: summaries });
      }
      this.repo.apply(
        parentId,
        [
          {
            type: "item.upsert",
            agent,
            item,
            draft: {
              type: "delegation.settled",
              origin: "ace",
              delivery,
              results: summaries,
              complete: true,
            },
          },
        ],
        this.clock.now(),
      );
    });
  }
}
