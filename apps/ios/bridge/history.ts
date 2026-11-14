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
 * A search hit carries no settlement, pin or archive state, so a hit the list hasn't loaded is
 * paged in first (as Show older threads does, a few pages at most) and admitted only through its
 * loaded entry, by the same rules as the rest. Every machine groups and dates against the moment
 * the phone sends, so merged answers file each thread under one group.
 */

export const HistoryRequest = z.object({
  type: z.literal("history.query"),
  query: z.string().max(512).default(""),
  /** The phone's clock (ms), the same for every machine it asks. */
  now: z.number().finite().nonnegative().optional(),
  /** Page older threads in to resolve search hits; off for a re-read the paging itself caused. */
  older: z.boolean().default(true),
});
export type HistoryRequest = z.infer<typeof HistoryRequest>;

export interface HistoryThread {
  id: string;
  title: string;
  /** The project's name. */
  project: string;
  workspaceId: string;
  at: number;
  group: HistoryGroup;
  /** The group's words: "This week", "Last week", "Earlier". */
  label: string;
  /** Its age within the past week ("3h"), else the day ("Oct 24"), as the web's rows say. */
  date: string;
  /** Always on the machine's list: a hit is shown only once its entry is loaded. */
  listed: boolean;
}

export interface HistoryAnswer {
  threads: HistoryThread[];
}

/** What History reads on one machine. */
export interface HistoryPorts {
  entries(): readonly ThreadListEntry[];
  /** Threads the machine's own search finds for `text`. */
  search(text: string): Promise<readonly { threadId: string }[]>;
  /** The list still holds older threads back. */
  holdsOlder(): boolean;
  /** Pages the next older threads into the list. */
  loadOlder(): Promise<void>;
  now(): number;
}

/** At most this many pages are read to resolve one query's hits. */
export const olderPages = 5;

const isChat = (entry: ThreadListEntry) => entry.details?.workspace?.kind === "chat";
const projectOf = (entry: ThreadListEntry) => entry.details?.workspace?.name ?? entry.workspaceId;

/** A thread History lists: settled, and not pinned, archived, deleted or a chat. */
function belongs(entry: ThreadListEntry): boolean {
  return (
    entry.archivedAt === undefined &&
    entry.deletedAt === undefined &&
    entry.pinned !== true &&
    !isChat(entry) &&
    isSettled(entry)
  );
}

function thread(entry: ThreadListEntry, now: number): HistoryThread {
  const at = entry.activityAt ?? entry.updatedAt;
  const group = historyGroupOf(at, now);
  return {
    id: entry.id,
    title: preview(entry.title, 512),
    project: preview(projectOf(entry), 512),
    workspaceId: entry.workspaceId,
    at,
    group,
    label: historyGroupLabels[group],
    date: historyDate(at, now),
    listed: true,
  };
}

const newestFirst = (a: HistoryThread, b: HistoryThread) => b.at - a.at || a.id.localeCompare(b.id);

/**
 * The settled threads this machine lists that match `query` by the web's rule, or that its
 * search `found`, newest first.
 */
export function settledHistory(
  entries: readonly ThreadListEntry[],
  query: string,
  now: number,
  found: ReadonlySet<string> = new Set(),
): HistoryThread[] {
  const text = query.trim();
  return entries
    .filter(
      (entry) =>
        belongs(entry) && (threadMatches(entry, text, projectOf(entry)) || found.has(entry.id)),
    )
    .map((entry) => thread(entry, now))
    .toSorted(newestFirst);
}

async function searched(ports: HistoryPorts, text: string): Promise<Set<string>> {
  if (text.length < 2) return new Set();
  try {
    return new Set((await ports.search(text)).map((hit) => hit.threadId));
  } catch {
    return new Set();
  }
}

/** Pages older threads in until every hit is loaded, the list ends, or `olderPages` are read. */
async function resolveHits(ports: HistoryPorts, hits: ReadonlySet<string>): Promise<void> {
  const unloaded = () => {
    const loaded = new Set<string>(ports.entries().map((entry) => entry.id));
    return [...hits].some((id) => !loaded.has(id));
  };
  for (let page = 0; page < olderPages && unloaded() && ports.holdsOlder(); page++) {
    try {
      await ports.loadOlder();
    } catch {
      return;
    }
  }
}

export async function answerHistory(
  ports: HistoryPorts,
  request: HistoryRequest,
): Promise<HistoryAnswer> {
  const text = request.query.trim();
  const now = request.now ?? ports.now();
  const hits = await searched(ports, text);
  if (request.older && hits.size) await resolveHits(ports, hits);
  return { threads: settledHistory(ports.entries(), text, now, hits) };
}
