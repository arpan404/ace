/*
 * What the Add project search box means: letters to search a daemon's folders for, or a path
 * being browsed, and the shell-like edits of path mode (go up one folder). The daemon does the
 * searching and completing (`fs.search`, `fs.complete`); this only reads the box.
 */
import {
  childFolder,
  displayPath,
  folderName,
  parentFolder,
  projectNameProblem,
} from "./projects.ts";

/** What the search box holds: letters to search for, or a path to browse. */
export type FolderQuery =
  | { kind: "search"; text: string }
  /** Browse `directory`, narrowed to the names that start with (or fuzzily match) `segment`. */
  | { kind: "path"; directory: string; segment: string };

/** Typing one of these switches the box to path browsing. */
export function isPathInput(text: string): boolean {
  return (
    text.startsWith("/") ||
    text === "~" ||
    text.startsWith("~/") ||
    text === "." ||
    text === ".." ||
    text.startsWith("./") ||
    text.startsWith("../")
  );
}

/** "/a/./b/../c" → "/a/c"; never climbs above the root. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * Reads the box. `/…` is absolute, `~` and `~/…` start at the host's home, `./…` and `../…` at
 * `cwd` (the folder browsing started in). Anything else is a search. Without the home or `cwd`
 * a path that needs it stays a search.
 */
export function parseFolderQuery(
  text: string,
  home: string | undefined,
  cwd: string | undefined,
): FolderQuery {
  if (!isPathInput(text)) return { kind: "search", text: text.trim() };
  let absolute: string;
  if (text.startsWith("/")) absolute = text;
  else if (text.startsWith("~")) {
    if (home === undefined) return { kind: "search", text };
    absolute = `${home}/${text.slice(2)}`;
  } else {
    if (cwd === undefined) return { kind: "search", text };
    absolute = `${cwd}/${text === "." || text === ".." ? `${text}/` : text}`;
  }
  const cut = absolute.lastIndexOf("/");
  const segment = absolute.slice(cut + 1);
  // "." and ".." as the last segment are a folder still being typed, not a name to match.
  if (segment === "..")
    return { kind: "path", directory: normalize(`${absolute.slice(0, cut)}/..`), segment: "" };
  return { kind: "path", directory: normalize(absolute.slice(0, cut)), segment };
}

/** The box's text for browsing `directory`: "~/code/", "/srv/", "/". */
export function pathInput(directory: string, home: string | undefined): string {
  const shown = displayPath(directory, home);
  return shown.endsWith("/") ? shown : `${shown}/`;
}

/**
 * Backspace on an empty segment, or ⌘↑: the box's text one folder up. Stops at `/` and at any
 * of `stops` (the allowed roots), where it returns undefined and the key does its usual thing.
 */
export function upInput(
  query: Extract<FolderQuery, { kind: "path" }>,
  home: string | undefined,
  stops: readonly string[] = [],
): string | undefined {
  if (query.segment) return pathInput(query.directory, home);
  if (stops.includes(query.directory)) return undefined;
  const parent = parentFolder(query.directory);
  return parent === undefined ? undefined : pathInput(parent, home);
}

/** A folder the box names that doesn't exist yet: where it would be made, and its name. */
export interface NewFolder {
  path: string;
  name: string;
}

/**
 * The folder the box's text would create. A path names itself (`~` already expanded by
 * `parseFolderQuery`); a bare folder name goes in `base`. Undefined when the text names no
 * single folder: empty, a filesystem root, a name a folder can't have, or a bare name with
 * separators in it.
 */
export function newFolder(query: FolderQuery, base: string | undefined): NewFolder | undefined {
  let path: string;
  if (query.kind === "path")
    path = query.segment ? childFolder(query.directory, query.segment) : query.directory;
  else if (base !== undefined && query.text && projectNameProblem(query.text) === undefined)
    path = childFolder(base, query.text);
  else return undefined;
  const name = folderName(path);
  if (parentFolder(path) === undefined || projectNameProblem(name) !== undefined) return undefined;
  return { path, name };
}

/**
 * Where a bare name is created: beside the most recently used project when its folder is
 * inside an allowed root (people keep projects side by side), else `start`, where browsing
 * opens (home, or the first allowed root).
 */
export function newFolderBase(
  recent: readonly string[],
  roots: readonly string[],
  start: string | undefined,
): string | undefined {
  const latest = recent[0];
  const beside = latest === undefined ? undefined : parentFolder(latest);
  const inside = (root: string) => {
    const top = root.replace(/\/+$/, "");
    return beside === top || beside?.startsWith(`${top}/`) === true;
  };
  return beside !== undefined && roots.some(inside) ? beside : start;
}
