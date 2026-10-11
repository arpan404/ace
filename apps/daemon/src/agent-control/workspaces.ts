import { realpath } from "node:fs/promises";
import {
  Command,
  type AgentWorkspace,
  type DelegationRequest,
  type McpAttribution,
} from "@ace/protocol";
import { requestedBase, requestedBaseKey } from "../worktree-base.ts";
import type { CommandContext } from "../commands.ts";
import type { CreationWorkspace } from "../creation-workspace.ts";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";
import { controlCommandId } from "./command-id.ts";
export type AgentWorkspaceContext = Pick<ServiceContext, "store" | "signal"> & {
  services: Pick<ServiceContext["services"], "workspaceActions">;
};

/** One workspace boundary for child work and ordinary conversation creation. */
export async function prepareAgentWorkspace(
  context: AgentWorkspaceContext,
  caller: McpAttribution,
  command: Command,
  strategy: AgentWorkspace,
  signal: AbortSignal,
): Promise<CreationWorkspace | undefined> {
  signal.throwIfAborted();
  const runtime = context.services.workspaceActions;
  const thread = context.store.getThread(caller.threadId);
  const project = thread && context.store.getWorkspacePath(thread.workspaceId);
  if (!project || !runtime) throw new Error("workspace_unavailable");
  if (strategy.kind === "project") return undefined;
  if (strategy.kind === "new_worktree") return runtime.prepareCreation(command, undefined, signal);
  const path = await realpath(strategy.path);
  signal.throwIfAborted();
  const worktrees = await runtime.git.listWorktrees(project);
  signal.throwIfAborted();
  const existing = worktrees.find((tree) => tree.path === path && !tree.bare);
  if (!existing) throw new Error("workspace_not_registered");
  const p = command.payload;
  if (p.type !== "thread.prepare" || !p.threadId) throw new Error("invalid_command");
  const workspace: NonNullable<CommandContext["preparedWorkspace"]> = {
    id: p.threadId,
    path,
    branch: existing.branch ?? "",
    project: await realpath(project),
    requestedBase: requestedBaseKey(requestedBase(p)),
  };
  signal.throwIfAborted();
  return { workspace, release: () => Promise.resolve() };
}

export function createWorkspaceDelegations(
  context: AgentWorkspaceContext,
  service: DelegationService,
) {
  const pending = new Map<
    string,
    { identity: string; work: Promise<import("@ace/protocol").DelegationRecord> }
  >();
  async function create(caller: McpAttribution, request: DelegationRequest, signal: AbortSignal) {
    const configured = await service.prepareModels(caller, request);
    signal.throwIfAborted();
    const receipt = service.journal.receipt(caller.threadId, request.requestId);
    if (receipt) {
      // The existing owner validates retry identity before returning the same child.
      return service.delegate(caller, request, configured);
    }
    const reservation = service.reserve(caller, request, undefined, configured);
    const watched = service.watchReservation(reservation);
    const lifetime = AbortSignal.any([signal, watched.signal, context.signal]);
    let prepared: CreationWorkspace | undefined;
    try {
      const parent = context.store.getThread(caller.threadId);
      if (!parent) throw new Error("parent_missing");
      const command = Command.parse({
        id: controlCommandId(caller.threadId, request.requestId, "workspace"),
        deviceId: "ace-agent",
        payload: {
          type: "thread.prepare",
          threadId: reservation.record.childId,
          workspaceId: parent.workspaceId,
          provider: request.provider,
          title: request.role.slice(0, 256),
          mode: "worktree",
          ...(request.workspace?.kind === "new_worktree" ? { base: request.workspace.base } : {}),
        },
      });
      prepared = await prepareAgentWorkspace(
        context,
        caller,
        command,
        request.workspace ?? { kind: "project" },
        lifetime,
      );
      lifetime.throwIfAborted();
      return context.store.atomic(() => {
        lifetime.throwIfAborted();
        const record = service.prepareReserved(
          caller,
          reservation,
          parent.workspaceId,
          undefined,
          prepared ? { preparedWorkspace: prepared.workspace } : undefined,
        );
        service.launch(record, `Role: ${request.role}\n\nTask:\n${request.task}`);
        return record;
      });
    } finally {
      watched.close();
      // The existing workspace owner retains accepted paths and compensates failures.
      try {
        await prepared?.release();
      } finally {
        service.releaseReservation(reservation);
      }
    }
  }
  return async (caller: McpAttribution, request: DelegationRequest, signal: AbortSignal) => {
    const key = `${caller.threadId}:${request.requestId}`;
    const identity = JSON.stringify([caller.agentId, request]);
    const existing = pending.get(key);
    if (existing) {
      if (existing.identity !== identity) throw new Error("Request identity conflict");
      return existing.work;
    }
    if (pending.size >= 4) throw new Error("Workspace admission busy");
    const work = create(caller, request, signal);
    pending.set(key, { identity, work });
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  };
}
