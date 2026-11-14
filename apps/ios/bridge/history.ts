import type { ClientCore } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import {
  historyDate,
  historyGroupLabels,
  historyGroupOf,
  isSettled,
  threadMatches,
  type HistoryGroup,
} from "@ace/ui-core";
import { z } from "zod";
import { preview } from "./presentation.ts";

/*
 * The phone's History (the web's `/history`): every settled thread on this machine, newest first,
 * each with the week group the web files it under. A query narrows the loaded ones by the web's
 * rule (title, project, branch, pull request) and adds older ones the machine's own search finds.
 * Each machine answers for itself; the phone merges them by time, so the groups stay in order.
 */

export const HistoryRequest = z.object({
  type: z.literal("history.query"),
  query: z.string().max(512).default(""),
});
export type HistoryRequest = z.infer<typeof HistoryRequest>;

export interface HistoryThread {
  id: string;
  title: string;
  /** The project's name; empty when the machine doesn't list it. */
  project: string;
  workspaceId: string;
  at: number;
  group: HistoryGroup;
  /** The group's words: "This week", "Last week", "Earlier". */
  label: string;
  /** Its age within the past week ("3h"), else the day ("Oct 24"), as the web's rows say. */
  date: string;
  /** On the machine's list now; otherwise found by its search (older, not loaded). */
  listed: boolean;
}

export interface HistoryAnswer {
  threads: HistoryThread[];
}

const searchLimit = 50;

const isChat = (entry: ThreadListEntry) => entry.details?.workspace?.kind === "chat";
const projectOf = (entry: ThreadListEntry) => entry.details?.workspace?.name ?? entry.workspaceId;

function thread(
  input: Omit<HistoryThread, "group" | "label" | "date" | "title" | "project"> & {
    title: string;
    project: string;
  },
  now: number,
): HistoryThread {
  const group = historyGroupOf(input.at, now);
  return {
    ...input,
    title: preview(input.title, 512),
    project: preview(input.project, 512),
    group,
    label: historyGroupLabels[group],
    date: historyDate(input.at, now),
  };
}

/** The settled threads this machine lists, matching `query`, newest first. */
export function settledHistory(
  entries: readonly ThreadListEntry[],
  query: string,
  now: number,
): HistoryThread[] {
  const text = query.trim();
  return entries
    .filter(
      (entry) =>
        entry.archivedAt === undefined &&
        entry.deletedAt === undefined &&
        entry.pinned !== true &&
        !isChat(entry) &&
        isSettled(entry) &&
        threadMatches(entry, text, projectOf(entry)),
    )
    .map((entry) =>
      thread(
        {
          id: entry.id,
          title: entry.title,
          project: projectOf(entry),
          workspaceId: entry.workspaceId,
          at: entry.activityAt ?? entry.updatedAt,
          listed: true,
        },
        now,
      ),
    )
    .toSorted((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** Threads the machine's search finds beyond its list; never fails the answer. */
async function searched(
  owner: ClientCore,
  entries: readonly ThreadListEntry[],
  query: string,
  requestId: string,
  now: number,
): Promise<HistoryThread[]> {
  if (query.length < 2) return [];
  const listed = new Set(entries.map((entry) => entry.id));
  const projects = new Map<string, string>();
  const chats = new Set<string>();
  for (const entry of entries)
    if (isChat(entry)) chats.add(entry.workspaceId);
    else projects.set(entry.workspaceId, projectOf(entry));
  try {
    const reply = await owner.request(
      { type: "search.query", requestId, text: query, scope: "threads", limit: searchLimit },
      { timeoutMs: 8_000 },
    );
    if (reply.type !== "search.results") return [];
    const seen = new Set<string>();
    return reply.hits.flatMap((hit) => {
      if (listed.has(hit.threadId) || seen.has(hit.threadId) || chats.has(hit.workspaceId))
        return [];
      seen.add(hit.threadId);
      return [
        thread(
          {
            id: hit.threadId,
            title: hit.threadTitle,
            project: projects.get(hit.workspaceId) ?? "",
            workspaceId: hit.workspaceId,
            at: hit.createdAt,
            listed: false,
          },
          now,
        ),
      ];
    });
  } catch {
    return [];
  }
}

export async function answerHistory(
  owner: ClientCore,
  entries: readonly ThreadListEntry[],
  request: HistoryRequest,
  requestId: string,
  now: number,
): Promise<HistoryAnswer> {
  const text = request.query.trim();
  const found = await searched(owner, entries, text, `${requestId}.history`, now);
  return {
    threads: [...settledHistory(entries, text, now), ...found].toSorted(
      (a, b) => b.at - a.at || a.id.localeCompare(b.id),
    ),
  };
}
