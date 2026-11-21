import { fuzzyPositions, quickOpenRows, type QuickOpenRow } from "@ace/ui-core";

/** How many rows each part of the empty list shows. */
export const quickOpenShortList = 8;

/**
 * Quick open's list before anything is typed (workbench spec 63): the open editors, most
 * recently used first, then files agents changed in this thread, then files opened recently.
 * A file shows once, in the first part that has it.
 */
export function emptyQuickOpenRows(lists: {
  open: readonly string[];
  changed: readonly string[];
  recent: readonly string[];
}): QuickOpenRow[] {
  const seen = new Set<string>();
  const part = (paths: readonly string[], group: string) => {
    const rows: QuickOpenRow[] = [];
    for (const path of paths) {
      if (rows.length >= quickOpenShortList) break;
      if (seen.has(path)) continue;
      seen.add(path);
      rows.push({ path, group });
    }
    return rows;
  };
  return [
    ...part(lists.open, "Open editors"),
    ...part(lists.changed, "Edited in this thread"),
    ...part(lists.recent, "Opened recently"),
  ];
}

/**
 * Quick open's list for a query: the files it already knows (open editors, then files agents
 * changed, then recent ones) that match, together with the index's `matches`, ranked as one
 * list with each file once. Before the index answers, the known files are the list.
 */
export function typedQuickOpenRows(
  query: string,
  matches: readonly string[],
  known: { open: readonly string[]; changed: readonly string[]; recent: readonly string[] },
): QuickOpenRow[] {
  const found = [...known.open, ...known.changed, ...known.recent].filter(
    (path) => fuzzyPositions(query, path) !== undefined,
  );
  return quickOpenRows(query, [...new Set([...found, ...matches])], [], []);
}
