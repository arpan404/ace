import type { OrchestrationThreadActivity, OrchestrationCheckpointSummary } from "@ace/contracts";

const COMPACTED_ACTIVITY_PAYLOAD_VERSION = 1;

export function compactActivityForClient(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  if (payload?.compacted === true && payload.uiSummary === true) {
    return activity;
  }
  return {
    ...activity,
    summary: compactActivitySummary(activity),
    payload: compactActivityPayload(activity),
  };
}

export function compactCheckpointSummaryForClient(
  checkpoint: OrchestrationCheckpointSummary,
): OrchestrationCheckpointSummary {
  const { diff: _diff, ...withoutDiff } = checkpoint;
  return withoutDiff;
}

function compactActivitySummary(activity: OrchestrationThreadActivity): string {
  const payload = asRecord(activity.payload);
  const itemType = asTrimmedString(payload?.itemType);
  const requestKind = asTrimmedString(payload?.requestKind);
  const kind = activity.kind.toLowerCase();

  if (kind.includes("context-window")) return "Context updated";
  if (kind.includes("approval") || requestKind) return "Approval";
  if (kind.includes("warning")) return "Runtime warning";
  if (kind.includes("error") || activity.tone === "error") return "Runtime error";
  if (kind.includes("reasoning") || kind === "task.progress") return "Thinking";
  if (kind.includes("command") || itemType === "command" || requestKind === "command") {
    return "Command";
  }
  if (kind.includes("tool") || itemType === "tool") return "Tool call";
  if (kind.includes("checkpoint")) return "Checkpoint";
  return activity.summary;
}

function compactActivityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> {
  const payload = asRecord(activity.payload);
  const compacted: Record<string, unknown> = {
    compacted: true,
    version: COMPACTED_ACTIVITY_PAYLOAD_VERSION,
    originalKind: activity.kind,
  };

  copyString(payload, compacted, "status");
  copyString(payload, compacted, "itemType");
  copyString(payload, compacted, "requestKind");
  copyString(payload, compacted, "taskId");
  copyString(payload, compacted, "requestId");
  copyNumber(payload, compacted, "exitCode");
  copyNumber(payload, compacted, "durationMs");
  copyNumber(payload, compacted, "tokenCount");
  copyNumber(payload, compacted, "totalTokens");
  copyNumber(payload, compacted, "inputTokens");
  copyNumber(payload, compacted, "outputTokens");

  return compacted;
}

function copyString(
  source: Record<string, unknown> | null,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = asTrimmedString(source?.[key]);
  if (value) {
    target[key] = value;
  }
}

function copyNumber(
  source: Record<string, unknown> | null,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
