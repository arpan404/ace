import {
  CommandId,
  type AgentControlResult,
  type AgentControlOperation,
  type McpAttribution,
  type ThreadId,
  type Transfer,
  type WorkspaceId,
} from "@ace/protocol";
import type { PublicToolCode } from "@ace/mcp-server";
import { AgentControlError } from "../agent-control/failure.ts";
import type { Store } from "../store.ts";
import type { TransferCommands } from "./commands.ts";
import type { OutgoingRecord } from "./outgoing-rows.ts";
import type { OutgoingTransfers } from "./outgoing.ts";
import { TransferError } from "./ports.ts";

type TransferOperation = Extract<AgentControlOperation, { op: "transfer" }>;

export interface AgentTransferDeps {
  store: Store;
  commands: TransferCommands;
  outgoing: OutgoingTransfers;
  /** `remote.agentTransfers`, read on every call. */
  enabled(): Promise<boolean>;
  /** A local project by id or name, for `project`. */
  project(name: string): WorkspaceId | undefined;
  /** The thread's background hold, so its tree never reads done while the transfer runs. */
  hold(
    thread: ThreadId,
    agent: McpAttribution["agentId"],
    transferId: string,
    change: { title: string } | { status: "completed" | "failed" | "stopped" },
  ): void;
  /** Hands the settled result to the thread as a new turn; `key` names it once. */
  deliver(thread: ThreadId, key: string, text: string): void;
  now(): number;
}

const codes: Record<string, PublicToolCode> = {
  machine_not_linked: "machine_unavailable",
  machine_offline: "machine_offline",
  machine_forbidden: "machine_forbidden",
  thread_busy: "thread_busy",
  thread_not_found: "thread_not_found",
  workspace_not_found: "not_found",
};

function agentError(error: unknown): unknown {
  if (!(error instanceof TransferError)) return error;
  return new AgentControlError(
    codes[error.code] ?? "execution_failed",
    error.code,
    error,
    error.message,
  );
}

/** What the thread reads when its transfer settles. */
export function transferResultText(transfer: Transfer): string {
  const to = transfer.target.name;
  if (transfer.phase === "completed" && transfer.result) {
    const { path, branch, threadId } = transfer.result;
    return (
      `Transfer ${transfer.transferId} to ${to} completed: the project is at ${path} on ${to}` +
      (branch ? `, on branch ${branch}` : "") +
      (threadId
        ? `. This thread continues there as thread ${threadId}; the person sends the next message there.`
        : ".")
    );
  }
  if (transfer.phase === "cancelled")
    return `Transfer ${transfer.transferId} to ${to} was cancelled.`;
  return `Transfer ${transfer.transferId} to ${to} failed: ${transfer.error?.message ?? "it stopped unexpectedly."}`;
}

/**
 * The agents' `transfer` tool (ADR 0099 "Agents"). It returns at once with the transfer id; the
 * result arrives as a new turn, and a background hold keeps the agent's tree working meanwhile.
 */
export class AgentTransfers {
  private deps: AgentTransferDeps;
  constructor(deps: AgentTransferDeps) {
    this.deps = deps;
  }
  async transfer(
    caller: McpAttribution,
    operation: TransferOperation,
  ): Promise<AgentControlResult> {
    const { store, outgoing } = this.deps;
    if (!(await this.deps.enabled()))
      throw new AgentControlError(
        "transfers_off",
        "transfers_off",
        undefined,
        'This machine doesn\'t let agents move work to other machines. The person can turn on "Agents can move projects and threads to other machines" in Settings › Fleet.',
      );
    const thread = store.getThread(caller.threadId);
    if (!thread) throw new AgentControlError("thread_not_found", "caller_missing");
    if (thread.permission?.effective === "read-only")
      throw new AgentControlError(
        "machine_forbidden",
        "read_only_caller",
        undefined,
        "This thread is read-only, so it can't move work to another machine.",
      );
    if (operation.thread && operation.project)
      throw new AgentControlError(
        "invalid_arguments",
        "thread_and_project",
        undefined,
        'Pass project or thread: "self", not both.',
      );
    const workspaceId = operation.project
      ? this.deps.project(operation.project)
      : thread.workspaceId;
    if (!workspaceId)
      throw new AgentControlError(
        "invalid_arguments",
        "unknown_project",
        undefined,
        `No project "${operation.project?.slice(0, 64)}" on this machine.`,
      );
    try {
      const target = await outgoing.resolveProfile(operation.machine);
      const self = operation.thread === "self";
      // One running transfer per thread, project and machine: a repeated call returns it.
      const running = outgoing
        .list()
        .find(
          (entry) =>
            !["completed", "failed", "cancelled"].includes(entry.phase) &&
            entry.target.hostId === target.hostId &&
            entry.workspaceId === workspaceId &&
            (self ? entry.threadId === caller.threadId : entry.threadId === undefined) &&
            outgoing.get(entry.transferId)?.request.agent?.threadId === caller.threadId,
        );
      if (running) return { ok: true, data: this.view(running, operation.machine) };
      const transfer = await this.deps.commands.start({
        commandId: CommandId.parse(`transfer-agent:${caller.threadId}:${this.deps.now()}`),
        hostId: target.hostId,
        includeChanges: operation.includeChanges ?? true,
        includeIgnored: operation.includeIgnored,
        ...(self ? { threadId: caller.threadId } : { workspaceId }),
        asker: { kind: "agent", threadId: caller.threadId, agentId: caller.agentId, self },
        hold: (started) =>
          this.deps.hold(caller.threadId, caller.agentId, started.transferId, {
            title: `Transfer to ${started.target.name}`,
          }),
      });
      return { ok: true, data: this.view(transfer, operation.machine) };
    } catch (error) {
      throw agentError(error);
    }
  }
  private view(transfer: Transfer, machine: string) {
    return {
      transferId: transfer.transferId,
      machine,
      phase: transfer.phase,
      next: "The result arrives as a new turn when the transfer settles. Don't poll.",
    };
  }
  /** A settled agent transfer: its result goes to the thread, then the hold ends. */
  settled(record: OutgoingRecord): void {
    const agent = record.request.agent;
    if (!agent || record.delivered) return;
    const { transfer } = record;
    try {
      this.deps.deliver(
        agent.threadId,
        `transfer-result:${transfer.transferId}`,
        transferResultText(transfer),
      );
      this.deps.hold(agent.threadId, agent.agentId, transfer.transferId, {
        status:
          transfer.phase === "completed"
            ? "completed"
            : transfer.phase === "cancelled"
              ? "stopped"
              : "failed",
      });
      this.deps.outgoing.markDelivered(transfer.transferId);
    } catch {
      // Not ready yet: delivered on the next start, never dropped.
    }
  }
}
