import { useSidebarThread } from "@ace/client-react";
import { useState } from "react";
import type { ThreadListEntry } from "@ace/protocol";
import { threadCard, projectLabel, type ThreadCard } from "@ace/ui-core";
import { useProjectMetadata } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
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
  leaving = false,
): { entry: ThreadListEntry; card: ThreadCard; icon: string | null | undefined } | undefined {
  const liveEntry = useOverlaidEntry(useSidebarThread(threadId));
  // Pagination removes archived entries immediately. Only this mounted row retains its
  // last immutable entry, so an inert exit animation can finish without keeping history
  // in the sidebar store. Its snapshot is released when the row unmounts.
  const [lastEntry, setLastEntry] = useState(liveEntry);
  if (liveEntry !== undefined && liveEntry !== lastEntry) setLastEntry(liveEntry);
  const entry = liveEntry ?? (leaving ? lastEntry : undefined);
  // Only mounted rows read one cursor, once per execution/read change. No history or polling.
  const read = useDaemonQuery({
    queryKey: ["sidebar-thread-read", threadId, entry?.activitySeq, entry?.readAt],
    read: (client, signal) => client.threadReadState({ threadId }, { signal }),
    enabled: entry?.activitySeq !== undefined && !settled,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const details = useCardDetails(entry);
  const organizer = useOrganizer();
  const now = useNow();
  const projectFor = useProjectMetadata();
  if (!entry) return undefined;
  // The baseline is fixed when the organizer is first created, so reading it once is enough.
  const project = projectFor(entry.workspaceId);
  const { baseline } = organizer.getState();
  return {
    entry,
    icon: project?.icon ?? project?.defaultIcon,
    card: threadCard({
      entry,
      details,
      baseline,
      settled,
      now,
      projectName: projectLabel(entry.workspaceId, project),
      readState: read.data,
    }),
  };
}
