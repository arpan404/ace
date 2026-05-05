import type { OrchestrationThreadActivity } from "@ace/contracts";

import { compareActivitiesByOrder } from "./shared";
import type { GeneratedWorkspaceSummary } from "./types";

export function toGeneratedWorkspaceSummary(
  activity: OrchestrationThreadActivity,
): GeneratedWorkspaceSummary | null {
  const payload =
    activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return null;
  }

  const headline = typeof payload.headline === "string" ? payload.headline.trim() : "";
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  const keyChanges = Array.isArray(payload.keyChanges)
    ? payload.keyChanges.filter((entry): entry is string => typeof entry === "string")
    : [];
  const risks = Array.isArray(payload.risks)
    ? payload.risks.filter((entry): entry is string => typeof entry === "string")
    : [];

  if (headline.length === 0 || summary.length === 0) {
    return null;
  }

  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    headline,
    summary,
    keyChanges,
    risks,
  };
}

export function deriveLatestGeneratedWorkspaceSummary(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): GeneratedWorkspaceSummary | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const summaries = ordered.filter((activity) => activity.kind === "workspace.summary.generated");

  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const activity = summaries[index];
    if (!activity) {
      continue;
    }
    const summary = toGeneratedWorkspaceSummary(activity);
    if (summary) {
      return summary;
    }
  }

  return null;
}
