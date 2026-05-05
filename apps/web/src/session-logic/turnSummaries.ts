import type { OrchestrationThreadActivity } from "@ace/contracts";

import { compareActivitiesByOrder } from "./shared";
import type { GeneratedWorkspaceSummary } from "./types";

function buildGeneratedWorkspaceSummaryMarkdown(input: {
  headline: string;
  summary: string;
  keyChanges: ReadonlyArray<string>;
  risks: ReadonlyArray<string>;
}) {
  const sections = [`### ${input.headline}`, "", input.summary.trim()];

  if (input.keyChanges.length > 0) {
    sections.push("", "#### Key changes", "", ...input.keyChanges.map((item) => `- ${item}`));
  }

  if (input.risks.length > 0) {
    sections.push("", "#### Watchouts", "", ...input.risks.map((item) => `- ${item}`));
  }

  return sections.join("\n").trim();
}

function normalizeSummaryHeadline(value: string): string {
  return value
    .replace(/^workspace\s+/iu, "")
    .replace(/^no workspace changes detected$/iu, "No Changes Detected");
}

function normalizeSummaryText(value: string): string {
  return value
    .replace(/The current workspace has no uncommitted diff\./giu, "There is no uncommitted diff.")
    .replace(/\bcurrent workspace\b/giu, "current diff")
    .replace(/\bworkspace\b/giu, "diff");
}

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

  const headline =
    typeof payload.headline === "string" ? normalizeSummaryHeadline(payload.headline.trim()) : "";
  const summary =
    typeof payload.summary === "string" ? normalizeSummaryText(payload.summary.trim()) : "";
  const keyChanges = Array.isArray(payload.keyChanges)
    ? payload.keyChanges
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => normalizeSummaryText(entry))
    : [];
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => normalizeSummaryText(entry))
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
    markdown: buildGeneratedWorkspaceSummaryMarkdown({
      headline,
      summary,
      keyChanges,
      risks,
    }),
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
