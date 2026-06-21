import type { OrchestrationThreadActivity } from "@ace/contracts";

export const DEFAULT_MAX_THREAD_ACTIVITIES = 2_000;

export function compareOrchestrationThreadActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function appendCompactedThreadActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
  options?: { maxEntries?: number | undefined },
): OrchestrationThreadActivity[] {
  const existingIndex = activities.findIndex((entry) => entry.id === activity.id);
  const withoutExisting =
    existingIndex < 0
      ? activities
      : [...activities.slice(0, existingIndex), ...activities.slice(existingIndex + 1)];
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_THREAD_ACTIVITIES;

  if (canAppendCompactedThreadActivity(withoutExisting, activity)) {
    return appendOrderedCompactedThreadActivity(withoutExisting, activity, maxEntries);
  }

  return compactOrchestrationThreadActivities(
    [...withoutExisting, activity].toSorted(compareOrchestrationThreadActivities),
  ).slice(-maxEntries);
}

export function compactOrchestrationThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const compacted: OrchestrationThreadActivity[] = [];

  for (const activity of activities) {
    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(activity);
      continue;
    }

    const merged = mergeReasoningActivities(previous, activity);
    if (merged) {
      compacted[compacted.length - 1] = merged;
      continue;
    }

    compacted.push(activity);
  }

  return compacted;
}

function canAppendCompactedThreadActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
): boolean {
  const previous = activities.at(-1);
  return !previous || compareOrchestrationThreadActivities(previous, activity) <= 0;
}

function appendOrderedCompactedThreadActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
  maxEntries: number,
): OrchestrationThreadActivity[] {
  const previous = activities.at(-1);
  if (!previous) {
    return [activity];
  }

  const merged = mergeReasoningActivities(previous, activity);
  if (merged) {
    const next = [...activities];
    next[next.length - 1] = merged;
    return next;
  }

  const next = [...activities, activity];
  return next.length > maxEntries ? next.slice(-maxEntries) : next;
}

function mergeReasoningActivities(
  previous: OrchestrationThreadActivity,
  next: OrchestrationThreadActivity,
): OrchestrationThreadActivity | null {
  const previousTaskId = reasoningTaskId(previous);
  const nextTaskId = reasoningTaskId(next);
  if (!previousTaskId || previousTaskId !== nextTaskId) {
    return null;
  }
  if (previous.turnId !== next.turnId) {
    return null;
  }

  const previousPayload = asRecord(previous.payload);
  const nextPayload = asRecord(next.payload);
  const mergedDetail = mergeReasoningText(
    reasoningPayloadText(previousPayload, "detail") ??
      reasoningPayloadText(previousPayload, "description"),
    reasoningPayloadText(nextPayload, "detail") ?? reasoningPayloadText(nextPayload, "description"),
  );
  const mergedSummary = mergeReasoningText(
    reasoningPayloadText(previousPayload, "summary"),
    reasoningPayloadText(nextPayload, "summary"),
  );

  return {
    ...previous,
    ...next,
    id: next.id,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined || next.sequence !== undefined
      ? { sequence: previous.sequence ?? next.sequence }
      : {}),
    payload: {
      ...previousPayload,
      ...nextPayload,
      taskId: previousTaskId,
      ...(mergedDetail ? { detail: mergedDetail, description: mergedDetail } : {}),
      ...(mergedSummary ? { summary: mergedSummary } : {}),
    },
  };
}

function reasoningTaskId(activity: OrchestrationThreadActivity): string | null {
  if (!isReasoningActivity(activity)) {
    return null;
  }
  return asTrimmedString(asRecord(activity.payload)?.taskId);
}

function isReasoningActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === "task.progress" || activity.kind === "reasoning.completed";
}

function reasoningPayloadText(
  payload: Record<string, unknown> | null,
  key: "detail" | "description" | "summary",
): string | null {
  return asTrimmedString(payload?.[key]);
}

function mergeReasoningText(previous: string | null, next: string | null): string | null {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }

  const needsSeparator = /[^\s]$/.test(previous) && /^[^\s]/.test(next);
  return `${previous}${needsSeparator ? " " : ""}${next}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
