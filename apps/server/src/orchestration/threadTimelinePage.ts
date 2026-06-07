import type {
  OrchestrationGetThreadTimelinePageInput,
  OrchestrationGetThreadTimelinePageResult,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadTimelineEntryReference,
} from "@ace/contracts";

const MAX_TIMELINE_PAGE_LIMIT = 256;

type TimelineSourceEntry =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly sequence?: number | undefined;
      readonly turnId?: OrchestrationMessage["turnId"];
      readonly sourceIndex: number;
      readonly value: OrchestrationMessage;
    }
  | {
      readonly kind: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly sequence?: number | undefined;
      readonly turnId?: OrchestrationThreadActivity["turnId"];
      readonly sourceIndex: number;
      readonly value: OrchestrationThreadActivity;
    }
  | {
      readonly kind: "proposed-plan";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId?: OrchestrationProposedPlan["turnId"];
      readonly sourceIndex: number;
      readonly value: OrchestrationProposedPlan;
    };

function readTimelineSourceSequence(entry: TimelineSourceEntry): number | undefined {
  switch (entry.kind) {
    case "message":
    case "activity":
      return entry.sequence;
    case "proposed-plan":
      return undefined;
  }
}

function compareTimelineSourceEntries(
  left: TimelineSourceEntry,
  right: TimelineSourceEntry,
): number {
  const leftSequence = readTimelineSourceSequence(left);
  const rightSequence = readTimelineSourceSequence(right);
  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.sourceIndex - right.sourceIndex || left.id.localeCompare(right.id);
}

function buildTimelineSourceEntries(thread: OrchestrationThread): TimelineSourceEntry[] {
  const entries: TimelineSourceEntry[] = [];
  let sourceIndex = 0;

  for (const message of thread.messages) {
    entries.push({
      kind: "message",
      id: message.id,
      createdAt: message.createdAt,
      ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
      ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
      sourceIndex,
      value: message,
    });
    sourceIndex += 1;
  }

  for (const activity of thread.activities) {
    entries.push({
      kind: "activity",
      id: activity.id,
      createdAt: activity.createdAt,
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      turnId: activity.turnId,
      sourceIndex,
      value: activity,
    });
    sourceIndex += 1;
  }

  for (const proposedPlan of thread.proposedPlans) {
    entries.push({
      kind: "proposed-plan",
      id: proposedPlan.id,
      createdAt: proposedPlan.createdAt,
      turnId: proposedPlan.turnId,
      sourceIndex,
      value: proposedPlan,
    });
    sourceIndex += 1;
  }

  if (entries.length > 1) {
    entries.sort(compareTimelineSourceEntries);
  }
  return entries;
}

function toReference(
  entry: TimelineSourceEntry,
  index: number,
): OrchestrationThreadTimelineEntryReference {
  const sequence = readTimelineSourceSequence(entry);
  return {
    kind: entry.kind,
    id: entry.id,
    createdAt: entry.createdAt,
    index,
    ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

export function buildThreadTimelinePage(
  thread: OrchestrationThread,
  input: Pick<OrchestrationGetThreadTimelinePageInput, "startIndex" | "limit">,
): OrchestrationGetThreadTimelinePageResult {
  const orderedEntries = buildTimelineSourceEntries(thread);
  const totalItems = orderedEntries.length;
  const startIndex = Math.min(Math.max(0, Math.trunc(input.startIndex)), totalItems);
  const limit = Math.min(MAX_TIMELINE_PAGE_LIMIT, Math.max(1, Math.trunc(input.limit)));
  const endIndexExclusive = Math.min(totalItems, startIndex + limit);
  const pageEntries = orderedEntries.slice(startIndex, endIndexExclusive);
  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const proposedPlans: OrchestrationProposedPlan[] = [];

  for (const entry of pageEntries) {
    switch (entry.kind) {
      case "message":
        messages.push(entry.value);
        break;
      case "activity":
        activities.push(entry.value);
        break;
      case "proposed-plan":
        proposedPlans.push(entry.value);
        break;
    }
  }

  return {
    threadId: thread.id,
    updatedAt: thread.updatedAt,
    totalItems,
    startIndex,
    endIndexExclusive,
    hasPrevious: startIndex > 0,
    hasNext: endIndexExclusive < totalItems,
    entries: pageEntries.map((entry, offset) => toReference(entry, startIndex + offset)),
    messages,
    activities,
    proposedPlans,
  };
}
