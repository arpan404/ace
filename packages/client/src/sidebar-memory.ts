import type { ThreadListView } from "@ace/protocol";
import type { SidebarHalf } from "./read-records.ts";

/** How many filters' lists a sidebar keeps in memory for this session (ADR 0030). */
export const rememberedFilters = 8;

/** Where a half painted before its subscription's snapshot came from. */
export type ProvisionalSource = "remembered" | "derived";

/**
 * The last list each sidebar filter held this session, least recently used dropped, so a switch
 * back paints at once. One entry per half and project: an archived filter's Home half is the
 * same list as its project's Home.
 */
export class FilterMemory {
  #lists = new Map<string, ThreadListView>();
  #limit: number;
  constructor(limit = rememberedFilters) {
    this.#limit = limit;
  }
  remember(half: SidebarHalf, project: string | undefined, view: ThreadListView): void {
    const key = keyOf(half, project);
    this.#lists.delete(key);
    this.#lists.set(key, view);
    for (const oldest of this.#lists.keys()) {
      if (this.#lists.size <= this.#limit) break;
      this.#lists.delete(oldest);
    }
  }
  /**
   * What to paint for a half until its subscription's snapshot lands: the list this filter
   * last held, or else the rows of the all-projects list that belong to `project`. Neither
   * carries the window, so nothing pages from it. Undefined when nothing sensible is held.
   */
  provisional(
    half: SidebarHalf,
    project: string | undefined,
  ): { view: ThreadListView; source: ProvisionalSource } | undefined {
    const key = keyOf(half, project);
    const remembered = this.#lists.get(key);
    if (remembered) {
      this.#lists.delete(key);
      this.#lists.set(key, remembered);
      return { view: withoutWindow(remembered), source: "remembered" };
    }
    if (project === undefined) return undefined;
    const all = this.#lists.get(keyOf(half, undefined));
    const view = all && narrow(all, project);
    return view && { view, source: "derived" };
  }
}

function keyOf(half: SidebarHalf, project: string | undefined): string {
  return JSON.stringify([half, project ?? null]);
}

function withoutWindow(view: ThreadListView): ThreadListView {
  const { window: _window, ...rest } = view;
  return rest;
}

/**
 * The rows of `all` in `project`. No rows is evidence the project is empty only when `all` was
 * known whole (its window had nothing before it); otherwise it derives nothing.
 */
function narrow(all: ThreadListView, project: string): ThreadListView | undefined {
  const threads = Object.fromEntries(
    Object.entries(all.threads).filter(([, entry]) => entry.workspaceId === project),
  );
  if (Object.keys(threads).length === 0 && all.window?.before !== null) return undefined;
  return { ...withoutWindow(all), threads };
}
