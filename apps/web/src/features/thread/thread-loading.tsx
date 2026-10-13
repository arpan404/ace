import { useConnectionState, useThreadSyncing } from "@ace/client-react";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { useHeld } from "@/lib/held.ts";
import { readingColumn } from "./lib/column.ts";

/**
 * A thread whose first messages haven't arrived. Nothing for a moment (most threads open
 * sooner), then "Loading messages…" over the shape of a transcript: an ask, a work line and
 * an answer. Shown only while there is nothing of the thread to show.
 */
export function ThreadLoading() {
  if (!useHeld(true)) return null;
  return (
    <LoadingRegion label="messages" className={`${readingColumn} flex flex-col pt-10`}>
      <p className="mb-6 text-center text-xs text-muted-foreground">Loading messages…</p>
      <Skeleton className="ml-auto h-14 w-3/5 rounded-lg rounded-br-sm" />
      <Skeleton className="mt-10 h-3 w-48" />
      <SkeletonText lines={4} className="mt-6" />
    </LoadingRegion>
  );
}

/**
 * "Syncing…" beside the title while a thread whose messages are on screen catches up on what
 * changed while the connection was away. Losing the connection, and getting it back, are the
 * connection notice's to say; this shows once it is ready, if catching up takes a moment.
 */
export function SyncingNote(props: { threadId: string }) {
  const syncing = useThreadSyncing(props.threadId);
  const connection = useConnectionState();
  // While it's still reconnecting the connection notice speaks; this waits until it's back.
  const catchingUp = syncing && connection === "ready";
  if (!useHeld(catchingUp)) return null;
  return (
    <span role="status" className="shrink-0 text-xs text-muted-foreground">
      Syncing…
    </span>
  );
}
