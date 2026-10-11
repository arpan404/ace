import { createHash } from "node:crypto";
import {
  Command,
  type McpAttribution,
  type ThreadStartOperation,
  type AgentControlResult,
} from "@ace/protocol";
import type { CreationWorkspace } from "../creation-workspace.ts";
import { prepareAgentWorkspace, type AgentWorkspaceContext } from "./workspaces.ts";
import { ConversationJournal } from "./conversation-journal.ts";
import { controlCommandId } from "./command-id.ts";
import type { DelegationService } from "./delegations.ts";

export function createConversationStarts(
  context: AgentWorkspaceContext,
  service: DelegationService,
  journal: ConversationJournal,
) {
  const pending = new Map<string, { identity: string; work: Promise<AgentControlResult> }>();
  // Git resource recovery is owned by WorkspaceCreations. These reservations never
  // launch autonomously after restart; a caller retries its original request.
  for (const reservation of service.journal.reservations())
    if (
      reservation.record.resultDelivery === "owner" &&
      reservation.record.request.requestId.startsWith("conversation-")
    )
      service.releaseReservation(reservation);

  async function start(
    caller: McpAttribution,
    operation: ThreadStartOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult> {
    const previous = journal.receipt(caller, operation.requestId);
    if (previous) {
      if (
        previous.ownerAgentId !== caller.agentId ||
        JSON.stringify(previous.request) !== JSON.stringify(operation)
      )
        return { ok: false, code: "invalid" };
      return { ok: true, data: { threadId: previous.threadId } };
    }
    const key = createHash("sha256")
      .update(JSON.stringify([caller.threadId, operation.requestId]))
      .digest("hex");
    const { op: _op, title, text, requestId: _requestId, ...selection } = operation;
    const request = {
      ...selection,
      requestId: `conversation-${key}`,
      task: text,
      role: title,
      wait: false,
      estimatedLoad: 0,
    };
    const configured = await service.prepareModels(caller, request);
    signal.throwIfAborted();
    const reservation = service.reserve(caller, request, "owner", configured);
    const watched = service.watchReservation(reservation);
    const lifetime = AbortSignal.any([signal, watched.signal, context.signal]);
    let preparation: CreationWorkspace | undefined;
    try {
      const parent = context.store.getThread(caller.threadId);
      if (!parent) throw new Error("Parent missing");
      const command = Command.parse({
        id: controlCommandId(caller.threadId, request.requestId, "workspace"),
        deviceId: "ace-agent",
        payload: {
          type: "thread.prepare",
          threadId: reservation.record.childId,
          workspaceId: parent.workspaceId,
          provider: operation.provider,
          mode: "worktree",
          title,
          ...(operation.workspace.kind === "new_worktree"
            ? { base: operation.workspace.base }
            : {}),
        },
      });
      preparation = await prepareAgentWorkspace(
        context,
        caller,
        command,
        operation.workspace,
        lifetime,
      );
      lifetime.throwIfAborted();
      return context.store.atomic(() => {
        lifetime.throwIfAborted();
        const child = service.prepareConversation(
          caller,
          reservation,
          parent.workspaceId,
          preparation ? { preparedWorkspace: preparation.workspace } : undefined,
        );
        journal.add({
          threadId: child.id,
          ownerThreadId: caller.threadId,
          ownerAgentId: caller.agentId,
          rootId: reservation.record.rootId,
          createdAt: reservation.record.createdAt,
          request: operation,
        });
        const sent = service.message(caller, request.requestId, child.id, text, "queue");
        if (!sent.ok) throw new Error("Initial message rejected");
        return { ok: true, data: { threadId: child.id } };
      });
    } finally {
      watched.close();
      try {
        await preparation?.release();
      } finally {
        service.releaseReservation(reservation);
      }
    }
  }
  return async (caller: McpAttribution, operation: ThreadStartOperation, signal: AbortSignal) => {
    const key = `${caller.threadId}:${operation.requestId}`,
      identity = JSON.stringify([caller.agentId, operation]);
    const previous = pending.get(key);
    if (previous) {
      if (previous.identity !== identity) return { ok: false, code: "invalid" as const };
      return previous.work;
    }
    if (pending.size >= 4) return { ok: false, code: "limit" as const };
    const work = start(caller, operation, signal);
    pending.set(key, { identity, work });
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  };
}
