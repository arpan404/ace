import { useSidebarThread } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { threadCard, type ThreadCard } from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import { useThreadDetails } from "./thread-details.ts";
import { useOrganizer, useThreadMark } from "./use-organizer.ts";

/**
 * One Home row's view model, live: its own list entry and mark (so other threads' updates skip
 * it), the shared minute clock, and the card wording from @ace/ui-core.
 */
export function useThreadCard(
  threadId: string,
  settled: boolean,
): { entry: ThreadListEntry; card: ThreadCard } | undefined {
  const entry = useSidebarThread(threadId);
  const mark = useThreadMark(threadId);
  const details = useThreadDetails(threadId);
  const organizer = useOrganizer();
  const now = useNow();
  if (!entry) return undefined;
  // The baseline is fixed when the organizer is first created, so reading it once is enough.
  const { baseline } = organizer.getState();
  return { entry, card: threadCard({ entry, mark, details, baseline, settled, now }) };
}
