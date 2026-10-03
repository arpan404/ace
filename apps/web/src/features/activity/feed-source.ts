/*
 * The Activity feed from the daemon: pull-request, CI and mention events from the forge for
 * threads with a linked PR (`workspace.request` `pr.status`), and Deck escalations from the
 * conductor (`@/features/deck`). Which events this device has read is kept per client here.
 */
import type { SidebarReader } from "@ace/client";
import { useClient, useConnectionState, useSidebar, useSidebarIds } from "@ace/client-react";
import type { SidebarKey } from "@ace/client-react";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { useDeckSender } from "@/features/deck/index.ts";
import { useEscalations } from "./escalations.ts";
import { pullRequestEvents, type FeedEvent, type LinkedThread } from "./feed-events.ts";
import { useReadState } from "./read-state.ts";

export type { FeedAction, FeedEvent, FeedKind } from "./feed-events.ts";

export interface FeedSnapshot {
  events: readonly FeedEvent[];
  /** Ids read on this device: feed events and automation runs share the set. */
  read: ReadonlySet<string>;
}

export interface FeedSource {
  markRead(ids: readonly string[]): void;
  /** Take an escalation's decision; it leaves Needs you once the deck reports the gate closed. */
  resolve(event: FeedEvent, actionId: string): Promise<void>;
}

export function useFeedSource(): FeedSource {
  const reads = useReadState();
  const send = useDeckSender();
  return {
    markRead: (ids) => reads.mark(ids),
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
const noIds: readonly string[] = [];

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
  const ids = useSidebarIds() ?? noIds;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  return useSidebar(keys, readLinked, sameList) ?? [];
}

/** The forge's view of each linked PR: checks and comments, read again every two minutes. */
function usePullRequestEvents(): FeedEvent[] {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const threads = useLinkedThreads();
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
  return threads.flatMap((thread, index) =>
    pullRequestEvents(thread, statuses[index]?.data ?? null),
  );
}

export function useFeed(): FeedSnapshot {
  const reads = useReadState();
  const read = useSyncExternalStore(reads.subscribe, reads.snapshot, reads.snapshot);
  const escalations = useEscalations();
  const forge = usePullRequestEvents();
  return { events: [...escalations, ...forge], read };
}
