import { maxForgeTextLength } from "@ace/protocol/forge";

/** Host text cut to the protocol's longest field. One long record never fails a read; the
 * whole response is already bounded by its ReadBudget. */
export function clipText(value: string): string {
  return value.slice(0, maxForgeTextLength);
}

/** At most 100 labels, each cut to the protocol's longest field. */
export function clipLabels(labels: readonly string[] | undefined): string[] {
  return (labels ?? []).slice(0, 100).map(clipText);
}
