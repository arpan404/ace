import type {
  OrchestrationGetSnapshotInput,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@ace/contracts";

function toLatestProposedPlanSummary(
  proposedPlan: OrchestrationProposedPlan,
): OrchestrationThread["latestProposedPlanSummary"] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function findLatestProposedPlanSummary(
  proposedPlans: ReadonlyArray<OrchestrationProposedPlan>,
): OrchestrationThread["latestProposedPlanSummary"] {
  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  return latestPlan ? toLatestProposedPlanSummary(latestPlan) : null;
}

function createSnapshotThread(thread: OrchestrationThread): OrchestrationThread {
  const messagesChanged = thread.messages.length > 0;
  const activitiesChanged = thread.activities.length > 0;
  const checkpointsChanged = thread.checkpoints.length > 0;
  const proposedPlansChanged = thread.proposedPlans.length > 0;

  if (!messagesChanged && !activitiesChanged && !checkpointsChanged && !proposedPlansChanged) {
    return thread;
  }

  return {
    ...thread,
    messages: [],
    activities: [],
    proposedPlans: [],
    latestProposedPlanSummary:
      thread.latestProposedPlanSummary ?? findLatestProposedPlanSummary(thread.proposedPlans),
    checkpoints: [],
  };
}

export function createReadModelSnapshotView(
  readModel: OrchestrationReadModel,
  _input?: OrchestrationGetSnapshotInput,
): OrchestrationReadModel {
  let changed = false;

  const threads = readModel.threads.map((thread) => {
    const summaryThread = createSnapshotThread(thread);
    if (summaryThread !== thread) {
      changed = true;
    }
    return summaryThread;
  });

  if (!changed) {
    return readModel;
  }

  return {
    ...readModel,
    threads,
  };
}
