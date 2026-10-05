import { createThreadState } from "@ace/core";
import {
  Thread,
  type ExecutionSelection,
  type ThreadLineage,
  type ThreadId,
  type WorkspaceId,
  type AcpIdentity,
} from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
export function createEngineThread(
  repo: EngineRepository,
  input: {
    id: ThreadId;
    permissionMode?: import("@ace/protocol").PermissionMode;
    workspaceId: WorkspaceId;
    title: string;
    titleSource?: import("@ace/protocol").Thread["titleSource"];
    selection: ExecutionSelection;
    cwd: string;
    workspaceReady?: boolean;
    at: number;
    silenceMs: number;
    lineage?: ThreadLineage;
    client?: import("@ace/protocol").ThreadClientFields;
    acpIdentity?: AcpIdentity;
    backend?: import("@ace/engine-api").ProviderBackend;
    capabilities?: import("@ace/protocol").Capabilities;
    handoff?: { sourceThreadId: ThreadId; truncated: boolean; bytes: number };
  },
): void {
  const { id, workspaceId, selection, cwd, at, lineage } = input;
  repo.permissions.ensure(id, input.permissionMode);
  if (lineage) repo.permissions.parent(id, lineage.parentThreadId, at);
  const project = repo.store.getWorkspace(workspaceId);
  const parentDetails = lineage ? repo.store.getThread(lineage.parentThreadId)?.details : undefined;
  const mode = input.client?.details?.mode ?? parentDetails?.mode;
  const unprepared = input.client?.details?.mode === "worktree" && !input.workspaceReady;
  const thread = Thread.parse({
    ...input.client,
    details: {
      ...parentDetails,
      ...input.client?.details,
      workspace: {
        id: workspaceId,
        name: project?.name ?? workspaceId,
        path: project?.path ?? cwd,
      },
      mode,
      ...(unprepared ? { worktree: undefined } : { worktree: cwd }),
    },
    id,
    workspaceId,
    title: input.title,
    titleSource: input.titleSource ?? "provisional",
    provider: selection.provider,
    execution: selection,
    lineage,
    backend: input.backend,
    capabilities: input.capabilities,
    handoff: input.handoff,
    ...input.acpIdentity,
    permission: repo.permissions.ensure(id, input.permissionMode),
    status: { state: "new" },
    createdAt: at,
    updatedAt: at,
  });
  const state = createThreadState({
    threadId: id,
    config: { provider: selection.provider, silenceMs: input.silenceMs },
    rootAgent: {
      agent: "root",
      fidelity: "full",
      native: { provider: selection.provider, ...input.acpIdentity },
      cwd,
      ...(selection.model ? { model: selection.model } : {}),
      ...(lineage ? { lineage } : {}),
    },
  });
  repo.save(state, [{ type: "thread.created", thread }], at);
  if (unprepared)
    repo.createUnpreparedSession(
      id,
      cwd,
      selection.model,
      input.backend,
      selection.instanceId,
      selection.options,
    );
  else
    repo.createSession(
      id,
      cwd,
      selection.model,
      input.backend,
      selection.instanceId,
      selection.options,
    );
  repo.queue.ensure(id);
  repo.transitions.set(id, { selection, context: [] });
  repo.transitions.remember(id, selection);
}
