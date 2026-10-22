import { createHash } from "node:crypto";
import type { AutomationExecutor, ExecutionInput, ExecutionResult } from "@ace/automations";
import {
  type AgentId,
  CommandId,
  DeviceId,
  type McpAttribution,
  type ThreadId,
} from "@ace/protocol";
import { automationRunExecutor } from "../automation-run-executor.ts";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";
import { controlCommandId } from "./command-id.ts";

const deviceId = DeviceId.parse("agent-automation");
const runKey = (value: string) =>
  CommandId.parse(`agent-automation-${createHash("sha256").update(value).digest("hex")}`);

/** The thread and agent that made an automation. */
export interface AutomationOwner {
  thread_id: ThreadId;
  agent_id: AgentId;
}

/**
 * Runs an automation an agent made from its thread by sending the message into that same
 * thread, queued behind any turn already going, so every run is one more turn of it. The thread
 * keeps its own model and effort. A deleted or archived thread fails the run instead of waiting.
 * Runs begun before this, each in a delegated child thread of its own, are still followed and
 * stopped as children, so an upgrade never runs one twice.
 */
export function ownerThreadExecutor(
  context: ServiceContext,
  delegations: DelegationService,
  ownerOf: (automationId: string) => AutomationOwner | undefined,
): AutomationExecutor {
  const { store } = context;
  /** The delegated child an older run started, found by the run's key as its request id. */
  const legacyChild = (input: ExecutionInput) => {
    const owner = ownerOf(input.automationId);
    if (!owner) return undefined;
    const edge = delegations.journal.receipt(owner.thread_id, input.idempotencyKey);
    if (!edge) return undefined;
    const caller: McpAttribution = {
      sessionId: `automation:${input.automationId}`,
      threadId: owner.thread_id,
      agentId: owner.agent_id,
    };
    return { caller, child: edge.childId };
  };
  return automationRunExecutor(
    context,
    {
      deviceId,
      commandId: runKey,
      admission(input) {
        if (input.worktree) throw new Error("Use thread.handoff for worktrees");
        const threadId = ownerOf(input.automationId)?.thread_id;
        const thread = threadId && store.getThread(threadId);
        if (!thread || thread.deletedAt !== undefined)
          throw new Error("The thread that made this automation was deleted.");
        if (thread.archivedAt !== undefined)
          throw new Error("The thread that made this automation is archived.");
        return {
          threadId: thread.id,
          payload: {
            type: "thread.send",
            threadId: thread.id,
            delivery: "queue",
            trigger: "schedule",
            origin: { kind: "automation", role: input.automationId },
            input: [{ type: "text", text: input.prompt }],
          },
        };
      },
      legacy: {
        follow(_key, input, signal) {
          const found = input && legacyChild(input);
          if (!found) return undefined;
          return delegations
            .wait(found.caller, found.child, signal)
            .then((result): ExecutionResult => ({
              threadId: found.child,
              status: result.outcome === "completed" ? "succeeded" : "failed",
              result: result.result.slice(0, 8192),
            }));
        },
        stop(input) {
          const found = legacyChild(input);
          if (!found) return undefined;
          return store.write(() => {
            const result = delegations.command(
              controlCommandId(found.caller.threadId, input.idempotencyKey, "automation.stop"),
              { type: "thread.interrupt", threadId: found.child, cascade: true },
            );
            if (!result.ok && result.error !== "thread_not_found")
              throw new Error(result.error ?? "Stop failed");
          });
        },
      },
    },
    () => (thread, command) => delegations.hostStop(thread, command),
  );
}
