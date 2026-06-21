import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@ace/contracts";
import {
  compactActivityForClient,
  compactCheckpointSummaryForClient,
} from "@ace/shared/orchestrationActivityPresentation";

export function sanitizeReadModelForClient(
  readModel: OrchestrationReadModel,
): OrchestrationReadModel {
  return {
    ...readModel,
    threads: readModel.threads.map(sanitizeThreadForClient),
  };
}

export function sanitizeThreadForClient(thread: OrchestrationThread): OrchestrationThread {
  return {
    ...thread,
    activities: thread.activities.map(compactActivityForClient),
    checkpoints: thread.checkpoints.map(compactCheckpointSummaryForClient),
  };
}

export function sanitizeOrchestrationEventForClient(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type === "thread.activity-appended") {
    return {
      ...event,
      payload: {
        ...event.payload,
        activity: compactActivityForClient(event.payload.activity),
      },
    };
  }
  if (event.type === "thread.turn-diff-completed") {
    const { diff: _diff, ...payload } = event.payload;
    return {
      ...event,
      payload,
    };
  }
  return event;
}
