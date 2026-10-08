import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import { useCallback, useMemo } from "react";
import { useThreadIdsWhere } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { inProject, useActivityState } from "./activity-state.tsx";
import { useWaitingSince } from "./waiting-since.tsx";

/** One thread waiting on a person. */
export type NeedsYouEntry = { kind: "thread"; threadId: string; since: number };

/** Waiting on a person and not snoozed by them, in a project the filter passes. */
function waiting(
  reader: SidebarReader,
  id: string,
  project: string | undefined,
  now: number,
): boolean {
  const thread = reader.thread(id);
  return (
    thread?.status.state === "needs_you" &&
    !((thread.snoozedUntil ?? 0) > now) &&
    inProject(project, thread.workspaceId)
  );
}

/** Waiting threads, oldest request first. Snoozed threads wait until they wake. */
export function useNeedsYou(): {
  threadIds: readonly string[];
  entries: readonly NeedsYouEntry[];
} {
  const { project } = useActivityState();
  // Snoozes end on the minute; the list follows.
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  const predicate = useCallback(
    (reader: SidebarReader, id: string) => waiting(reader, id, project, minute * 60_000),
    [project, minute],
  );
  const threadIds = useThreadIdsWhere(predicate);
  const since = useWaitingSince();
  const entries = useMemo(() => {
    const all: NeedsYouEntry[] = threadIds.map((threadId) => ({
      kind: "thread" as const,
      threadId,
      since: since.get(threadId) ?? Number.MAX_SAFE_INTEGER,
    }));
    return all.toSorted((a, b) => a.since - b.since);
  }, [threadIds, since]);
  return { threadIds, entries };
}

/** Open requests across unsnoozed threads, optionally filtered by project. */
export function useNeedsYouCount(options: { project?: string | undefined } = {}): number {
  const { project } = options;
  const minute = Math.floor(useNow() / 60_000);
  const pendingTotal = useCallback(
    (reader: SidebarReader) =>
      reader.ids.reduce((sum, id) => {
        const status = reader.thread(id)?.status;
        return status?.state === "needs_you" && waiting(reader, id, project, minute * 60_000)
          ? sum + status.interactions
          : sum;
      }, 0),
    [project, minute],
  );
  const pending = useSidebarAll(pendingTotal) ?? 0;
  return pending;
}
