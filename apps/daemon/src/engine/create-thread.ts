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
    workspaceId: WorkspaceId;
    title: string;
    selection: ExecutionSelection;
    cwd: string;
    at: number;
    silenceMs: number;
    lineage?: ThreadLineage;
    acpIdentity?: AcpIdentity;
  },
): void {
  const { id, workspaceId, selection, cwd, at, lineage } = input;
  const thread = Thread.parse({
    id,
    workspaceId,
    title: input.title,
    provider: selection.provider,
    execution: selection,
    lineage,
    ...input.acpIdentity,
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
  repo.createSession(id, cwd, selection.model);
  repo.queue.ensure(id);
  repo.transitions.set(id, { selection, context: [] });
  repo.transitions.remember(id, selection);
  repo.store.atomic((db) =>
    db
      .prepare("UPDATE engine_sessions SET instance_id=? WHERE thread_id=?")
      .run(selection.instanceId ?? null, id),
  );
}
