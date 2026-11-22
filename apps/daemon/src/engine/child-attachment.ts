import type { AgentId, Thread, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/** Host-owned summary attachment. Child transcript and native session stay independent. */
export function attachChild(
  repo: EngineRepository,
  at: number,
  parentId: ThreadId,
  parentAgentId: AgentId,
  child: Thread,
  role: string,
  background: boolean,
): void {
  repo.permissions.parent(child.id, parentId, at);
  const state = repo.requireState(parentId);
  const parent = state.indexes.agentKeysById[parentAgentId];
  if (!parent) throw new Error("Unknown parent agent");
  repo.apply(
    parentId,
    [
      {
        type: "agent.seen",
        agent: `ace-child:${child.id}`,
        parent,
        origin: "ace",
        fidelity: "summary",
        native: { provider: child.provider },
        cwd: repo.session(child.id).cwd,
        role,
        background,
      },
      {
        type: "agent.external",
        agent: `ace-child:${child.id}`,
        threadId: child.id,
        status: child.status,
      },
    ],
    at,
  );
}
