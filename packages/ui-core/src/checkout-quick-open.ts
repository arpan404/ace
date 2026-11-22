import { rememberRecent } from "./checkout-files.ts";

/*
 * Quick open for every client's Files tool, pure: what was typed ("src/app.ts:42") as the file to
 * find and the line to show, the rows to offer (the daemon's best-first matches, or with nothing
 * typed the files opened recently and then the files changed), and the per-thread lists a device
 * keeps (recent files, and on the phone the files left open in place of tabs).
 */

/** "src/app.ts:42" → the file to find and the line to show. */
export function parseQuickOpen(text: string): { query: string; line: number | undefined } {
  const match = /^(.*?):(\d+)$/.exec(text.trim());
  if (!match?.[1]) return { query: text.trim(), line: undefined };
  return { query: match[1], line: Number(match[2]) || undefined };
}

export interface QuickOpenRow {
  path: string;
  /** The heading the row sits under. */
  group: string;
}

/** How many recent and changed files show with nothing typed. */
const shortList = 8;

/**
 * How well a path's name answers what was typed: 0 the name itself or its stem ("tabs" for
 * tabs.ts; typed with a folder, the path's end), 1 a name that starts with it, 2 a name that
 * holds it, 3 letters found in order.
 */
function nameTier(query: string, path: string): number {
  const typed = query.toLowerCase().replace(/\s+/g, "");
  const full = path.toLowerCase().replace(/\/$/, "");
  if (typed.includes("/") && (full === typed || full.endsWith(`/${typed}`))) return 0;
  const word = typed.slice(typed.lastIndexOf("/") + 1);
  const name = full.slice(full.lastIndexOf("/") + 1);
  if (!word) return 3;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (name === word || stem === word) return typed.includes("/") ? 1 : 0;
  if (name.startsWith(word)) return 1;
  return name.includes(word) ? 2 : 3;
}

/**
 * `paths` (the daemon's fuzzy matches, best first) with the names that answer `query` best
 * moved up: the exact name, then names that start with it, then names that hold it, then the
 * rest. The daemon's order stands within each tier, so "workspace-tabs.ts" lists that file
 * before "workspace/bottom-tabs.ts", which only matches letter by letter.
 */
export function rankPathMatches(query: string, paths: readonly string[]): string[] {
  return paths
    .map((path, index) => ({ path, index, tier: nameTier(query, path) }))
    .toSorted((a, b) => a.tier - b.tier || a.index - b.index)
    .map((each) => each.path);
}

/**
 * The rows quick open offers. With a query: the daemon's matches, the best names first
 * (`rankPathMatches`), files only. With none: up to eight files opened recently, then up to
 * eight `changed` files not among them.
 */
export function quickOpenRows(
  query: string,
  matches: readonly string[],
  recent: readonly string[],
  changed: readonly string[],
  changedGroup = "Edited in this thread",
): QuickOpenRow[] {
  if (query)
    return rankPathMatches(
      query,
      matches.filter((path) => !path.endsWith("/")),
    ).map((path) => ({ path, group: "Files" }));
  const opened = recent.slice(0, shortList);
  const seen = new Set(opened);
  return [
    ...opened.map((path) => ({ path, group: "Opened recently" })),
    ...changed
      .filter((path) => !seen.has(path))
      .slice(0, shortList)
      .map((path) => ({ path, group: changedGroup })),
  ];
}

/** One list per scope (a thread), most recently used scope first. */
export type ScopedLists = readonly (readonly [string, readonly string[]])[];

export interface ScopedLimits {
  /** Entries kept for each scope. */
  perScope: number;
  /** Scopes kept; the least recently used goes first. */
  scopes: number;
}

/** `lists` with `scope`'s list replaced by `next` and moved to the front; an empty list goes. */
export function putScoped(
  lists: ScopedLists,
  scope: string,
  next: readonly string[],
  limits: ScopedLimits,
): ScopedLists {
  const rest = lists.filter(([id]) => id !== scope);
  const kept = next.slice(0, limits.perScope);
  return (kept.length ? [[scope, kept] as const, ...rest] : rest).slice(0, limits.scopes);
}

/** The list kept for `scope`, or none. */
export function scopedList(lists: ScopedLists, scope: string): readonly string[] {
  return lists.find(([id]) => id === scope)?.[1] ?? [];
}

/** `path` remembered first among `scope`'s recent files. */
export function rememberScoped(
  lists: ScopedLists,
  scope: string,
  path: string,
  limits: ScopedLimits,
): ScopedLists {
  return putScoped(
    lists,
    scope,
    rememberRecent(scopedList(lists, scope), path, limits.perScope),
    limits,
  );
}

/**
 * The files left open in a scope, in the order they were first opened: opening one already open
 * keeps its place; a new one goes last, and past `limit` the oldest goes.
 */
export function openInList(open: readonly string[], path: string, limit: number): string[] {
  if (open.includes(path)) return [...open];
  return [...open, path].slice(-limit);
}

/** `open` without `path`, and anything inside it when it names a folder ("src/"). */
export function closeInList(open: readonly string[], path: string): string[] {
  return open.filter((each) => each !== path && !(path.endsWith("/") && each.startsWith(path)));
}

/** A path renamed or moved: every entry at or inside `from` now sits at `to`, order kept. */
export function moveInList(list: readonly string[], from: string, to: string): string[] {
  const moved = list.map((each) =>
    each === from ? to : each.startsWith(`${from}/`) ? to + each.slice(from.length) : each,
  );
  return [...new Set(moved)];
}
