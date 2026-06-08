import type {
  OrchestrationGetSnapshotInput,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@ace/contracts";
const INITIAL_SNAPSHOT_ACTIVITY_LIMIT_PER_THREAD = 32;

function shouldHydrateAllThreadHistory(input?: OrchestrationGetSnapshotInput): boolean {
  return input === undefined || !Object.prototype.hasOwnProperty.call(input, "hydrateThreadId");
}

function createSummaryThread(thread: OrchestrationThread): OrchestrationThread {
  const latestUserMessage = thread.messages.filter((message) => message.role === "user").at(-1);
  const summaryMessages = latestUserMessage ? [latestUserMessage] : [];
  const summaryActivities =
    thread.activities.length > INITIAL_SNAPSHOT_ACTIVITY_LIMIT_PER_THREAD
      ? thread.activities.slice(-INITIAL_SNAPSHOT_ACTIVITY_LIMIT_PER_THREAD)
      : thread.activities;

  const messagesChanged = summaryMessages.length !== thread.messages.length;
  const activitiesChanged = summaryActivities.length !== thread.activities.length;
  const checkpointsChanged = thread.checkpoints.length > 0;
  const proposedPlansChanged = thread.proposedPlans.length > 0;

  if (!messagesChanged && !activitiesChanged && !checkpointsChanged && !proposedPlansChanged) {
    return thread;
  }

  return {
    ...thread,
    messages: messagesChanged ? summaryMessages : thread.messages,
    activities: activitiesChanged ? summaryActivities : thread.activities,
    proposedPlans: proposedPlansChanged ? [] : thread.proposedPlans,
    checkpoints: checkpointsChanged ? [] : thread.checkpoints,
  };
}

export function createReadModelSnapshotView(
  readModel: OrchestrationReadModel,
  input?: OrchestrationGetSnapshotInput,
): OrchestrationReadModel {
  if (shouldHydrateAllThreadHistory(input)) {
    return readModel;
  }

  const hydrateThreadId = input?.hydrateThreadId ?? null;
  let changed = false;

  const threads = readModel.threads.map((thread) => {
    if (hydrateThreadId !== null && thread.id === hydrateThreadId) {
      return thread;
    }
    const summaryThread = createSummaryThread(thread);
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
