import type { SidebarReader } from "@ace/client";
import { useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { cardDetails, homeMachine, type CardDetails } from "@ace/ui-core";
import { createContext, use, useCallback, useMemo } from "react";

/** The machine most threads run on; cards name a machine only when it is another one. */
export const HomeMachine = createContext<string | undefined>(undefined);

const none: readonly string[] = [];

/** Read once for the whole list, so rows don't each scan every entry. */
export function useHomeMachine(): string | undefined {
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
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
  return useSidebar(keys, select);
}

/** Branch, PR, worktree, machine and diff for a card, from the daemon's `details`. */
export function useCardDetails(entry: ThreadListEntry | undefined): CardDetails | undefined {
  const home = use(HomeMachine);
  return entry && cardDetails(entry, home);
}
