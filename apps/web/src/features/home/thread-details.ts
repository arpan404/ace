import { useMachineIdentity } from "@/lib/machine-identity.ts";
import type { ThreadListEntry } from "@ace/protocol";
import { cardDetails, type CardDetails } from "@ace/ui-core";

/** Branch, PR, worktree, machine and diff for a card, from its metadata and live host identity. */
export function useCardDetails(entry: ThreadListEntry | undefined): CardDetails | undefined {
  const machine = useMachineIdentity(entry?.details?.machine);
  const details = entry && cardDetails(entry, undefined);
  return (
    details && {
      ...details,
      machine: machine.primary ? undefined : machine.name,
      machineIcon: machine.icon,
    }
  );
}
