import { isDeepStrictEqual } from "node:util";
import type { ProviderGoal } from "@ace/protocol";

/**
 * The thread's goal after a provider report: the new goal, null to clear the one shown, or
 * undefined when nothing the thread shows would change.
 */
export function goalChange(
  current: ProviderGoal | undefined,
  next: ProviderGoal | null,
): ProviderGoal | null | undefined {
  if (next === null) return current ? null : undefined;
  return current && isDeepStrictEqual(current, next) ? undefined : next;
}
