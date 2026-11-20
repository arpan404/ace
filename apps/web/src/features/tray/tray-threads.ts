import type { ThreadListEntry } from "@ace/protocol";

/** The threads the menu-bar popover lists, by what they ask of the person. */
export interface TrayThreads {
  /** Waiting on the person: an approval, a question, a choice. */
  needsYou: readonly string[];
  /** At work, or waiting on something other than the person (a background task, the queue). */
  working: readonly string[];
}

export const noTrayThreads: TrayThreads = { needsYou: [], working: [] };

const latest = (a: ThreadListEntry, b: ThreadListEntry) => b.updatedAt - a.updatedAt;
const sameIds = (x: readonly string[], y: readonly string[]) =>
  x.length === y.length && x.every((id, index) => id === y[index]);

/**
 * Picks the popover's threads from the thread list: what needs the person, then what works,
 * each with the latest change first. Archived threads and threads at rest are left out.
 */
export function trayThreads(
  ids: readonly string[],
  thread: (id: string) => ThreadListEntry | undefined,
): TrayThreads {
  const needsYou: ThreadListEntry[] = [];
  const working: ThreadListEntry[] = [];
  for (const id of ids) {
    const entry = thread(id);
    if (!entry || entry.archivedAt !== undefined) continue;
    const { state } = entry.status;
    if (state === "needs_you") needsYou.push(entry);
    else if (state === "working" || state === "waiting") working.push(entry);
  }
  return {
    needsYou: needsYou.toSorted(latest).map((entry) => entry.id),
    working: working.toSorted(latest).map((entry) => entry.id),
  };
}

export function sameTrayThreads(a: TrayThreads, b: TrayThreads): boolean {
  return sameIds(a.needsYou, b.needsYou) && sameIds(a.working, b.working);
}

/** The popover's first line: how much works and what waits on the person. */
export function trayHeadline(threads: TrayThreads): { working: string; needsYou: string } {
  const working = threads.working.length;
  const needsYou = threads.needsYou.length;
  return {
    working: working ? `${working} working` : "Nothing working",
    needsYou: needsYou ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : "",
  };
}
