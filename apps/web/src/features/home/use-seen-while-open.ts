import { useClient, useConnectionState, useSidebarThread, useThreadMeta } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLayout } from "@/lib/layout.tsx";
import { rememberThread } from "./last-thread.ts";
/**
 * The open thread counts as read: tell the daemon once it has news, and again as it moves, so
 * every device sees it read. It is also the thread Home returns to.
 */
export function useSeenWhileOpen() {
  const params = useParams({ strict: false });
  const threadId = params.threadId;
  const listed = useSidebarThread(threadId ?? "");
  const direct = useThreadMeta(threadId ?? "");
  const entry = listed ?? direct;
  const client = useClient();
  const { storage } = useLayout();
  const ready = useConnectionState() === "ready";
  const queries = useQueryClient();
  // updatedAt also advances on read acknowledgements and organization changes.
  const activity = entry?.activitySeq ?? entry?.activityAt ?? entry?.createdAt;
  const sent = useRef<string>(undefined);
  useEffect(() => {
    sent.current = undefined;
    if (threadId && !threadId.startsWith("pending:")) rememberThread(storage, threadId);
  }, [storage, threadId]);
  useEffect(() => {
    if (!ready || !threadId || threadId.startsWith("pending:") || activity === undefined) return;
    // Once per thread and activity: marking the open thread unread by hand sticks until it
    // moves again or is opened anew.
    const key = `${threadId}@${activity}`;
    if (sent.current === key) return;
    sent.current = key;
    client
      .command({ type: "thread.read", threadId: ThreadId.parse(threadId), unread: false })
      .then(() => queries.invalidateQueries({ queryKey: ["sidebar-thread-read", threadId] }))
      .catch(() => {
        // Offline: try again when the list next changes.
        if (sent.current === key) sent.current = undefined;
      });
  }, [client, threadId, ready, activity, queries]);
}
