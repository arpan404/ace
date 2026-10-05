import { useSidebarThread } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { threadCard, type ThreadCard } from "@ace/ui-core";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useCardDetails } from "./thread-details.ts";
import { useOrganizer, useOverlaidEntry } from "@/features/organize/index.ts";

/**
 * One Home row's view model, live: its own list entry (so other threads' updates skip it) with
 * any organize action not yet confirmed, the shared minute clock, and the card wording from
 * @ace/ui-core.
 */
export function useThreadCard(
  threadId: string,
  settled: boolean,
): { entry: ThreadListEntry; card: ThreadCard } | undefined {
  const entry = useOverlaidEntry(useSidebarThread(threadId));
  const details = useCardDetails(entry);
  const organizer = useOrganizer();
  const now = useNow();
  const projectName = useProjectName();
  if (!entry) return undefined;
  // The baseline is fixed when the organizer is first created, so reading it once is enough.
  const { baseline } = organizer.getState();
  return {
    entry,
    card: threadCard({
      entry,
      details,
      baseline,
      settled,
      now,
      projectName: projectName(entry.workspaceId),
    }),
  };
}
