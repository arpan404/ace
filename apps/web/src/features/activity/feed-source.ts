/*
 * The Activity feed from the daemon: pull-request, CI and mention events from the forge for
 * threads with a linked PR (`workspace.request` `pr.status`), and Deck escalations from the
 * conductor (`@/features/deck`). What has been read is the daemon's Activity read cursor
 * (`read-state.ts`).
 */
import type { SidebarReader } from "@ace/client";
import { useClient, useConnectionState, useSidebarAll, useSidebarLoaded } from "@ace/client-react";
import type { AutomationRun } from "@ace/protocol";
import { isActivityRead } from "@ace/projection/activity-reads";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useAutomationRuns } from "@/features/automations/index.ts";
import { useDeckSender } from "@/features/deck/index.ts";
import { useEscalations } from "./escalations.ts";
import { pullRequestEvents, type FeedEvent, type LinkedThread } from "./feed-events.ts";
import { useReadCursor, useReadState } from "./read-state.ts";

export type { FeedAction, FeedEvent, FeedKind } from "./feed-events.ts";

export interface FeedSnapshot {
  events: readonly FeedEvent[];
  /** Automation runs, newest first; undefined until read. */
  runs: readonly AutomationRun[] | undefined;
  /** The runs have been read, or couldn't be: the feed can say what it has. */
  runsSettled: boolean;
  /** Ids of the events and runs that have been read (the daemon's cursor, on every device). */
  read: ReadonlySet<string>;
  /** False until the read cursor has arrived: nothing is called unread before then. */
  readLoaded: boolean;
  /** Every pull request's events have been read (or failed): absence now means gone. */
  eventsSettled: boolean;
  /** A pull request couldn't be read; `retryEvents` reads it again. */
  eventsFailed: boolean;
  retryEvents(): void;
}

export interface FeedSource {
  markRead(ids: readonly string[]): void;
  markUnread(ids: readonly string[]): void;
  /** Everything up to `at` is read. */
  markAllRead(at: number): void;
  /** Take an escalation's decision; it leaves Needs you once the deck reports the gate closed. */
  resolve(event: FeedEvent, actionId: string): Promise<void>;
}

export function useFeedSource(): FeedSource {
  const reads = useReadState();
  const send = useDeckSender();
  return {
    markRead: (ids) => reads.mark(ids),
    markUnread: (ids) => reads.mark(ids, false),
    markAllRead: (at) => reads.markAllBefore(at),
    async resolve(event, actionId) {
      const action = event.actions?.find((candidate) => candidate.id === actionId);
      if (!event.runId || !event.gateId || !action) throw new Error("not_found");
      await send({
        type: "conductor.approve",
        runId: event.runId,
        approval: { gateId: event.gateId, decision: action.id },
      });
      reads.mark([event.id]);
    },
  };
}

/** At most this many linked pull requests are read, the most recently active first. */
const linkedLimit = 12;
const prRefreshMs = 120_000;

function readLinked(reader: SidebarReader): LinkedThread[] {
  return reader.ids
    .flatMap((id) => {
      const thread = reader.thread(id);
      const pr = thread?.details?.linkedPr;
      if (!thread || !pr || thread.deletedAt !== undefined) return [];
      return [
        {
          id: thread.id,
          title: thread.title,
          workspaceId: thread.workspaceId,
          updatedAt: thread.updatedAt,
          settledAt: thread.settledAt,
          settledReason: thread.settledReason,
          pr: { number: pr.number, state: pr.state },
        },
      ];
    })
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, linkedLimit);
}

const sameLinked = (a: LinkedThread, b: LinkedThread) =>
  a.id === b.id &&
  a.title === b.title &&
  a.updatedAt === b.updatedAt &&
  a.settledAt === b.settledAt &&
  a.pr.number === b.pr.number &&
  a.pr.state === b.pr.state;
const sameList = (a: readonly LinkedThread[], b: readonly LinkedThread[]) =>
  a.length === b.length &&
  a.every((thread, index) => {
    const other = b[index];
    return other !== undefined && sameLinked(thread, other);
  });

function useLinkedThreads(): LinkedThread[] {
  return useSidebarAll(readLinked, sameList) ?? [];
}

/**
 * The forge's view of each linked PR: checks and comments, read again every two minutes.
 * `settled` once every read has answered or failed; `retry` reads the failed ones again.
 */
function usePullRequestEvents(): {
  events: FeedEvent[];
  settled: boolean;
  failed: boolean;
  retry(): void;
} {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const threads = useLinkedThreads();
  const loaded = useSidebarLoaded();
  const statuses = useQueries({
    queries: threads.map((thread) => ({
      queryKey: ["feed", "pr", thread.id, thread.pr.number, thread.pr.state],
      enabled: ready,
      staleTime: prRefreshMs / 2,
      refetchInterval: prRefreshMs,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const reply = await client.request(
          { type: "workspace.request", operation: { op: "pr.status", threadId: thread.id } },
          { signal },
        );
        return reply.result.kind === "pr" ? reply.result.status : null;
      },
    })),
  });
  return {
    events: threads.flatMap((thread, index) =>
      pullRequestEvents(thread, statuses[index]?.data ?? null),
    ),
    settled: loaded && ready && statuses.every((status) => !status.isPending),
    failed: statuses.some((status) => status.isError),
    retry: () => {
      for (const status of statuses) if (status.isError) void status.refetch();
    },
  };
}

/** When a run counts as happening: when it finished, else when it started. */
export const runAt = (run: AutomationRun) => run.finishedAt ?? run.startedAt;

export function useFeed(): FeedSnapshot {
  const reads = useReadState();
  const cursor = useReadCursor();
  const escalations = useEscalations();
  const pulls = usePullRequestEvents();
  const forge = pulls.events;
  const runsQuery = useAutomationRuns();
  const runs = runsQuery.data;
  const events = useMemo(() => [...escalations, ...forge], [escalations, forge]);
  const refs = useMemo(
    () => [
      ...events.map((event) => ({ id: event.id, at: event.at })),
      ...(runs ?? []).map((run) => ({ id: run.id, at: runAt(run) })),
    ],
    [events, runs],
  );
  useEffect(() => reads.know(refs), [reads, refs]);
  const read = useMemo(
    () =>
      new Set(cursor ? refs.filter((ref) => isActivityRead(cursor, ref)).map((ref) => ref.id) : []),
    [cursor, refs],
  );
  return {
    events,
    runs,
    runsSettled: runs !== undefined || runsQuery.isError,
    read,
    readLoaded: cursor !== undefined,
    eventsSettled: pulls.settled,
    eventsFailed: pulls.failed,
    retryEvents: pulls.retry,
  };
}
