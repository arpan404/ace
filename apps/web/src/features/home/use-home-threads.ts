import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useCallback, useMemo } from "react";
import { useNow } from "@/lib/time.ts";
import { arrange, projectCounts, type Arrangement, type ProjectCount } from "@ace/ui-core";
import { useOrganizerState } from "@/features/organize/index.ts";

const none: readonly string[] = [];
const empty: Arrangement = { active: [], settled: [] };
const noProjects: ProjectCount[] = [];

const entriesOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [entry] : [];
  });

/** Keys for every entry, so a selection over the whole list sees each status change. */
function useEveryEntryKey(): SidebarKey[] {
  const ids = useSidebarIds() ?? none;
  return useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
}

const arrangementEqual = (a: Arrangement, b: Arrangement) =>
  arrayEqual(a.active, b.active) && arrayEqual(a.settled, b.settled);

/**
 * Home order (needs you, moving, trouble, the rest; settled apart). Only ids are selected,
 * so a status change re-renders its own row and moves rows only when the order changes.
 */
export function useHomeArrangement(): Arrangement {
  const keys = useEveryEntryKey();
  const state = useOrganizerState();
  const now = useNow();
  const select = useCallback(
    (reader: SidebarReader) => arrange(entriesOf(reader), state, now),
    [state, now],
  );
  return useSidebar(keys, select, arrangementEqual) ?? empty;
}

const countsEqual = (a: ProjectCount[], b: ProjectCount[]) =>
  a.length === b.length && a.every((p, i) => p.id === b[i]?.id && p.threads === b[i]?.threads);

/** Projects that have threads here, with how many. */
export function useProjects(): ProjectCount[] {
  const keys = useEveryEntryKey();
  const state = useOrganizerState();
  const select = useCallback(
    (reader: SidebarReader) => projectCounts(entriesOf(reader), state),
    [state],
  );
  return useSidebar(keys, select, countsEqual) ?? noProjects;
}
