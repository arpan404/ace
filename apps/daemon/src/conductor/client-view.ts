import { ThreadId, type ConductorRunView } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "../agent-control/delegations.ts";
import type { ExecutionJournal } from "./journal.ts";
export function executionView(
  view: ConductorRunView,
  context: ServiceContext,
  journal: ExecutionJournal,
  delegationsService: DelegationService,
): ConductorRunView {
  const root = journal.root(view.id);
  if (!root) return view;
  const bindings = journal.lanes(view.id);
  const edges = delegationsService.journal.family(root.thread);
  const delegations = edges.flatMap((edge) => {
    const binding =
      bindings.find((entry) => entry.thread === edge.childId) ??
      bindings.find((entry) => delegationsService.journal.isDescendant(edge.childId, entry.thread));
    if (!binding) return [];
    const thread = context.store.getThread(edge.childId);
    return [
      {
        laneId: binding.lane,
        workstream: binding.workstream,
        threadId: edge.childId,
        agentId: thread?.rootAgentId ?? null,
        parentThreadId: edge.parentId,
        parentAgentId: edge.parentAgentId,
        provider: thread?.provider ?? edge.request.provider,
        account:
          context.services.engine?.sessionMetadata(edge.childId).instanceId ??
          `local.${thread?.provider ?? edge.request.provider}`,
        generation: binding.generation,
        phase: edge.phase,
      },
    ];
  });
  const needsUser = [...view.needsUser];
  for (const entry of delegations) {
    const snapshot = context.store.acquireThread(ThreadId.parse(entry.threadId));
    try {
      for (const interaction of Object.values(snapshot.interactions)) {
        if (interaction.state !== "pending") continue;
        needsUser.push({
          id: interaction.id,
          kind: "provider",
          workstream: entry.workstream,
          lane: entry.laneId,
          generation: entry.generation,
          message: `${interaction.request.kind} needs your answer`,
          gatedAt: interaction.createdAt,
          interactionId: interaction.id,
          threadId: entry.threadId,
        });
      }
    } finally {
      context.store.releaseThread(ThreadId.parse(entry.threadId));
    }
  }
  return {
    ...view,
    branch: root.branch.slice(0, 256),
    baseBranch: root.baseBranch?.slice(0, 256) ?? null,
    updatedAt: Math.max(
      view.updatedAt,
      ...delegations.map(
        (entry) => context.store.getThread(ThreadId.parse(entry.threadId))?.updatedAt ?? 0,
      ),
    ),
    lanes: view.lanes.map((lane) => ({
      ...lane,
      agentId:
        delegations.find(
          (entry) => entry.laneId === lane.id && entry.parentThreadId === root.thread,
        )?.agentId ?? lane.agentId,
    })),
    delegations: delegations.slice(0, 256),
    needsUser: needsUser.slice(0, 64),
    truncated: view.truncated || needsUser.length > 64 || delegations.length > 256,
  };
}
