/*
 * The palette's Local folder step: a path field over one machine's folders. The rows are `..`,
 * the folders inside the typed folder that match what follows the last slash, and, only when
 * the typed path doesn't exist, a row that creates it. Choosing never creates a folder unless
 * that row itself is chosen.
 */
import { pathInput } from "./folder-search.ts";
import { parentFolder } from "./projects.ts";

export interface PathEntry {
  name: string;
  path: string;
}

export type PathRow<E extends PathEntry = PathEntry> =
  /** The folder above the one being browsed. */
  | { kind: "up"; path: string }
  | { kind: "folder"; entry: E }
  /** The typed path doesn't exist: make it, then add it. */
  | { kind: "create"; path: string; name: string };

/**
 * The list under the field: `..` while nothing follows the last slash and the folder has a
 * parent, then `matches` (already filtered and ranked), then creating `missing` last.
 */
export function pathRows<E extends PathEntry>(input: {
  directory: string;
  segment: string;
  matches: readonly E[];
  missing: { path: string; name: string } | undefined;
}): PathRow<E>[] {
  const parent = input.segment ? undefined : parentFolder(input.directory);
  return [
    ...(parent === undefined ? [] : [{ kind: "up" as const, path: parent }]),
    ...input.matches.map((entry) => ({ kind: "folder" as const, entry })),
    ...(input.missing
      ? [{ kind: "create" as const, path: input.missing.path, name: input.missing.name }]
      : []),
  ];
}

/**
 * The folder the field names, when it exists: the folder being browsed while nothing follows
 * the slash (once it could be listed), else the listed folder named by the last segment
 * (exactly, or differing only in case as on the usual macOS disks). Undefined otherwise.
 */
export function typedFolder(input: {
  directory: string;
  segment: string;
  entries: readonly PathEntry[] | undefined;
}): string | undefined {
  if (!input.entries) return undefined;
  if (!input.segment) return input.directory;
  const lower = input.segment.toLowerCase();
  const found =
    input.entries.find((entry) => entry.name === input.segment) ??
    input.entries.find((entry) => entry.name.toLowerCase() === lower);
  return found?.path ?? undefined;
}

/** The path a row stands for. */
export function rowPath(row: PathRow): string {
  return row.kind === "folder" ? row.entry.path : row.path;
}

export type PathIntent =
  /** Show the folders inside this one. */
  | { kind: "browse"; path: string }
  | { kind: "add"; path: string }
  /** Make the folder, then add it: only from the create row. */
  | { kind: "create"; path: string }
  | { kind: "none" };

/**
 * What choosing does. `open` is Enter, → or a click: it goes into the highlighted folder.
 * `add` is ⌘Enter: it adds the highlighted folder. With nothing highlighted either one adds the
 * typed folder when it exists, and does nothing when it doesn't: a missing folder is only ever
 * made from its own row.
 */
export function choosePath(
  row: PathRow | undefined,
  how: "open" | "add",
  typed: string | undefined,
): PathIntent {
  if (!row) return typed === undefined ? { kind: "none" } : { kind: "add", path: typed };
  if (row.kind === "create") return { kind: "create", path: row.path };
  return { kind: how === "add" ? "add" : "browse", path: rowPath(row) };
}

/** The highlight after ↓ (1) or ↑ (-1), wrapping; from none, ↓ takes the first and ↑ the last. */
export function stepHighlight(
  current: number | undefined,
  delta: 1 | -1,
  count: number,
): number | undefined {
  if (count === 0) return undefined;
  if (current === undefined || current >= count) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/**
 * Where the field starts: the folder holding the most recent project, else `start` (where
 * browsing opens: home, or the first allowed place), else `~/`. `recent` is project paths,
 * most recently used first.
 */
export function startText(
  recent: readonly string[],
  home: string | undefined,
  start: string | undefined,
): string {
  const latest = recent[0];
  const at = (latest === undefined ? undefined : parentFolder(latest)) ?? start;
  return at === undefined ? "~/" : pathInput(at, home);
}
