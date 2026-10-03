import { ConductorRunView, ConductorSummary } from "@ace/protocol";
import type { Lane, Node, State } from "./schema.ts";

type Root = Pick<
  State,
  "id" | "spec" | "plan" | "phase" | "spent" | "planApproved" | "gates" | "startedAt" | "updatedAt"
>;
export function clientSummary(
  root: Pick<Root, "id" | "spec" | "phase" | "spent">,
): ConductorSummary {
  return ConductorSummary.parse({
    id: root.id,
    workspaceId: root.spec.workspaceId,
    goal: root.spec.goal,
    phase: root.phase,
    spent: root.spent,
    budget: root.spec.constraints.budget,
  });
}
/** Compact display facts omit execution artifacts and retired lane history. */
export function clientView(
  root: Root,
  lanes: readonly Pick<
    Lane,
    "id" | "agentId" | "role" | "workstream" | "account" | "model" | "generation" | "status"
  >[],
  nodes: readonly Pick<Node, "id" | "state" | "fixRounds" | "mergedRevision">[],
): ConductorRunView {
  const gates = Object.values(root.gates);
  const index = new Map(nodes.map((node) => [node.id, node]));
  return ConductorRunView.parse({
    ...clientSummary(root),
    startedAt: root.startedAt,
    updatedAt: root.updatedAt,
    plan: root.plan,
    planApproved: root.planApproved,
    needsUser: gates
      .slice(0, 64)
      .map((gate) => Object.assign({}, gate, { message: gate.message.slice(0, 2048) })),
    lanes: lanes.slice(0, 64).map((lane) => Object.assign({}, lane, { model: lane.model.model })),
    dag: (root.plan?.workstreams ?? []).map((workstream) => ({
      id: workstream.id,
      title: workstream.title,
      dependencies: workstream.dependencies,
      state: index.get(workstream.id)?.state,
      fixRounds: index.get(workstream.id)?.fixRounds,
      revision: index.get(workstream.id)?.mergedRevision,
    })),
    truncated: gates.length > 64 || lanes.length > 64,
  });
}
