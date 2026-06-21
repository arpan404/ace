import type { OrchestrationThreadActivity, OrchestrationCheckpointSummary } from "@ace/contracts";

export function compactActivityForClient(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  return activity;
}

export function compactCheckpointSummaryForClient(
  checkpoint: OrchestrationCheckpointSummary,
): OrchestrationCheckpointSummary {
  const { diff: _diff, ...withoutDiff } = checkpoint;
  return withoutDiff;
}
