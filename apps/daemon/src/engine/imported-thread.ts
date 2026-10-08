import { createThreadState } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/** Historical items remain in the paged Store. Only the live root enters the engine. */
export function adoptImportedThread(repo: EngineRepository, id: ThreadId, now: number): void {
  if (repo.state(id)) return;
  const thread = repo.store.getThread(id);
  if (!thread?.imported || !thread.rootAgentId) throw new Error("Imported thread unavailable");
  const root = repo.store.getMcpAgent(id, thread.rootAgentId);
  const workspace = repo.store.getWorkspace(thread.workspaceId);
  if (!root || !workspace) throw new Error("Imported project unavailable");
  const nativeId = root.native.nativeId ?? thread.imported.native.nativeId;
  if (!nativeId) throw new Error("Native session identity unavailable");
  const state = createThreadState({
    threadId: id,
    config: { provider: thread.provider, silenceMs: 60_000 },
  });
  state.rootKey = "root";
  state.agents.root = { agent: root, activity: "thinking", lastSignalAt: now };
  state.indexes.agentKeysById[root.id] = "root";
  repo.store.atomic(() => {
    repo.createSession(id, workspace.path, root.model, undefined, thread.imported?.instanceId);
    repo.nativeSession(id, nativeId);
    repo.permissions.ensure(id);
    repo.queue.ensure(id);
    repo.save(state, [], now);
  });
}
