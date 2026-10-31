import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar } from "@ace/client-react";
import type { SearchResults } from "@ace/protocol";
import { isRemoved, isSettled } from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { searchSettleMs, useDebouncedValue } from "@/lib/debounced.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useSidebarDevice } from "./device-filter-state.ts";
import type { HomeList, SettledEntry } from "./use-home-threads.ts";

/** One daemon search hit. */
export type SearchHit = SearchResults["hits"][number];

const noHits: ReadonlyMap<string, SearchHit> = new Map();
const noIds: readonly string[] = [];

/**
 * The daemon's thread search for what the person typed in the Threads panel, settled once
 * typing pauses (as the palette's): one hit per thread, its latest. Threads the list holds are
 * matched by their titles locally; this finds the settled ones it hasn't paged in, and loaded
 * ones whose messages match.
 */
function useThreadHits(query: string): ReadonlyMap<string, SearchHit> {
  const text = useDebouncedValue(query.trim(), searchSettleMs);
  const found = useDaemonQuery({
    queryKey: ["panel-threads", text],
    enabled: text.length > 0,
    read: async (client, signal) => {
      const reply = await client.request(
        { type: "search.query", scope: "threads", text, limit: 100 },
        { signal },
      );
      return reply.type === "search.results" ? reply.hits : [];
    },
  });
  return useMemo(() => {
    if (!text || !found.data?.length) return noHits;
    const byThread = new Map<string, SearchHit>();
    for (const hit of found.data) {
      const known = byThread.get(hit.threadId);
      if (!known || hit.createdAt > known.createdAt) byThread.set(hit.threadId, hit);
    }
    return byThread;
  }, [text, found.data]);
}

export interface SettledSearch {
  /** Hits for settled threads the list doesn't show yet, by thread id. */
  hits: ReadonlyMap<string, SearchHit>;
  /** Every settled match, newest first: the list's own, then the daemon's, merged by time. */
  matches: readonly SettledEntry[];
}

/**
 * The settled threads that match the panel's search: the loaded settled threads whose title,
 * project, branch or pull request match (`list.settled`, already narrowed by `useHomeList`),
 * and the daemon's hits for settled threads within the project and device filters that the
 * list hasn't paged in or whose messages match. A hit for a thread the list shows elsewhere
 * (pinned, active, snoozed) stays there.
 */
export function useSettledSearch(
  query: string,
  list: HomeList,
  loaded: readonly SettledEntry[],
): SettledSearch {
  const all = useThreadHits(query);
  const { project } = useOrganizerState();
  const device = useSidebarDevice();
  const own = usePrimaryMachine().id;
  const shown = useMemo(
    () => new Set([...list.pinned, ...list.listed, ...list.snoozed, ...list.settled]),
    [list.pinned, list.listed, list.snoozed, list.settled],
  );
  const offDevice = device !== undefined && device !== own;
  // Only hits whose thread is settled (or not loaded at all: the daemon pages settled threads).
  const select = useCallback(
    (reader: SidebarReader) => {
      if (offDevice || all.size === 0) return noIds;
      const ids: string[] = [];
      for (const [id, hit] of all) {
        if (shown.has(id)) continue;
        if (project !== null && hit.workspaceId !== project) continue;
        const entry = reader.thread(id);
        if (entry && (isRemoved(entry) || entry.pinned === true || !isSettled(entry))) continue;
        ids.push(id);
      }
      return ids;
    },
    [all, shown, project, offDevice],
  );
  const extra = useSidebar(["ids", "threads"], select, arrayEqual) ?? noIds;
  return useMemo(() => {
    if (!extra.length) return { hits: noHits, matches: loaded };
    const hits = new Map<string, SearchHit>();
    const added: SettledEntry[] = [];
    for (const id of extra) {
      const hit = all.get(id);
      if (!hit) continue;
      hits.set(id, hit);
      added.push({ id, at: hit.createdAt, project: hit.workspaceId });
    }
    const matches = [...loaded, ...added].toSorted((a, b) => b.at - a.at);
    return { hits, matches };
  }, [extra, all, loaded]);
}
