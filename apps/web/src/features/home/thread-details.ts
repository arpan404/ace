import { useMachineName } from "@/lib/host-name.ts";
import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { cardDetails, homeMachine, type CardDetails } from "@ace/ui-core";
import { createContext, use, useCallback } from "react";

/** The machine most threads run on; cards name a machine only when it is another one. */
export const HomeMachine = createContext<string | undefined>(undefined);

/** Read once for the whole list, so rows don't each scan every entry. */
export function useHomeMachine(): string | undefined {
  const select = useCallback(
    (reader: SidebarReader) =>
      homeMachine(
        reader.ids.flatMap((id) => {
          const entry = reader.thread(id);
          return entry ? [entry] : [];
        }),
      ),
    [],
  );
  return useSidebarAll(select);
}

/** Branch, PR, worktree, machine and diff for a card, from the daemon's `details`. */
export function useCardDetails(entry: ThreadListEntry | undefined): CardDetails | undefined {
  const home = use(HomeMachine);
  const machine = useMachineName(entry?.details?.machine);
  const details = entry && cardDetails(entry, home);
  if (details?.machine) return { ...details, machine };
  return details;
}
