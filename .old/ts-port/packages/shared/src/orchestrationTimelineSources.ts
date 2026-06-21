export type OrchestrationTimelineSourceKind = "message" | "activity" | "proposed-plan";

export interface OrchestrationTimelineSourceOrderInput {
  readonly kind: OrchestrationTimelineSourceKind;
  readonly id: string;
  readonly createdAt: string;
  readonly sequence?: number | null;
}

const SOURCE_KIND_PRIORITY: Record<OrchestrationTimelineSourceKind, number> = {
  message: 0,
  activity: 1,
  "proposed-plan": 2,
};

function compareNullableSequence(left?: number | null, right?: number | null): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined || left === null) {
    return 1;
  }
  if (right === undefined || right === null) {
    return -1;
  }
  return left - right;
}

export function compareOrchestrationTimelineSources(
  left: OrchestrationTimelineSourceOrderInput,
  right: OrchestrationTimelineSourceOrderInput,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    compareNullableSequence(left.sequence, right.sequence) ||
    SOURCE_KIND_PRIORITY[left.kind] - SOURCE_KIND_PRIORITY[right.kind] ||
    left.id.localeCompare(right.id)
  );
}
