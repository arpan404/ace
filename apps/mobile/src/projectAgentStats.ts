import type { OrchestrationThread, ProjectId } from "@ace/contracts";

export interface ProjectAgentStats {
  readonly working: number;
  readonly completed: number;
  readonly pending: number;
  readonly total: number;
}

function isWorkingThread(thread: OrchestrationThread): boolean {
  const sessionStatus = thread.session?.status;
  return sessionStatus === "starting" || sessionStatus === "running";
}

function isCompletedThread(thread: OrchestrationThread): boolean {
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "stopped" || sessionStatus === "error") {
    return true;
  }

  const latestTurnState = thread.latestTurn?.state;
  return latestTurnState === "completed" || latestTurnState === "error";
}

export function resolveProjectAgentStats(
  threads: ReadonlyArray<OrchestrationThread>,
  projectId: ProjectId,
): ProjectAgentStats {
  let working = 0;
  let completed = 0;
  let pending = 0;

  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.projectId !== projectId) {
      continue;
    }
    if (isWorkingThread(thread)) {
      working += 1;
      continue;
    }
    if (isCompletedThread(thread)) {
      completed += 1;
      continue;
    }
    pending += 1;
  }

  return {
    working,
    completed,
    pending,
    total: working + completed + pending,
  };
}
