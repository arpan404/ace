import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

/*
 * What `host.open` may open, and who may ask. A path names a project's folder, a personal skill
 * folder, or somewhere else on the machine; only the owner opens somewhere else. Every answer
 * comes from the resolved path (symlinks followed), never from what the client wrote.
 */

/** A resolved, existing target: a regular file or a folder. */
export interface HostTarget {
  target: string;
  isFile: boolean;
}

/** `operate` inside a project or personal skill folder; `admin` (the owner) anywhere else. */
export type HostScope = "operate" | "admin";

/** Folders whose contents an `operate` device may open; the daemon's own, never a client's. */
export interface HostPlaces {
  /** Registered projects' folders and live threads' checkouts. */
  projects: readonly string[];
  /** The personal skill folders, from the daemon's skills configuration. */
  skills: readonly string[];
}

/** A failure `host.open` reports by its public code. */
export class HostOpenError extends Error {
  readonly code: "path_not_found" | "path_not_openable" | "owner_only" | "forbidden";
  constructor(code: HostOpenError["code"]) {
    super(code);
    this.code = code;
  }
}

/**
 * The absolute path `path` names: absolute already, or from `~` in `home`. Undefined for a
 * relative path, `~user`, a NUL byte, or (on Windows) a network or device path, which reading
 * alone could reach out to another machine.
 */
export function expandHostPath(
  path: string,
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (path.includes("\0")) return undefined;
  const windows = platform === "win32";
  const absolute = windows ? win32.isAbsolute : isAbsolute;
  let expanded = path;
  if (path === "~") expanded = home;
  else if (path.startsWith("~/") || (windows && path.startsWith("~\\")))
    expanded = (windows ? win32.join : join)(home, path.slice(2));
  if (!absolute(expanded)) return undefined;
  if (windows && (/^[\\/]{2}/.test(expanded) || !/^[A-Za-z]:[\\/]/.test(expanded)))
    return undefined;
  return expanded;
}

/**
 * `path` through its symlinks, if it is a regular file or a folder. Refuses what doesn't exist
 * and what isn't a file or folder: devices, sockets and pipes.
 */
export async function resolveExisting(path: string): Promise<HostTarget> {
  let target: string;
  try {
    target = await realpath(path);
  } catch {
    throw new HostOpenError("path_not_found");
  }
  const info = await stat(target).catch(() => undefined);
  if (!info) throw new HostOpenError("path_not_found");
  if (!info.isFile() && !info.isDirectory()) throw new HostOpenError("path_not_openable");
  return { target, isFile: info.isFile() };
}

/** Whether `target` is `root` or inside it; both already resolved. */
export function within(root: string, target: string): boolean {
  const inside = relative(root, target);
  return (
    inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  );
}

/** Each folder through its symlinks; ones that don't exist drop out. */
async function resolvedRoots(roots: readonly string[]): Promise<string[]> {
  const found = await Promise.all(
    roots.filter((root) => isAbsolute(root)).map((root) => realpath(root).catch(() => undefined)),
  );
  return found.filter((root): root is string => root !== undefined);
}

/** Who may open `target` (resolved): `operate` inside a project or skill folder, else `admin`. */
export async function hostScope(target: string, places: HostPlaces): Promise<HostScope> {
  const roots = await resolvedRoots([...places.projects, ...places.skills]);
  return roots.some((root) => within(root, target)) ? "operate" : "admin";
}

/**
 * `path` inside `root`, resolved through symlinks. Refuses an absolute or escaping path, one
 * that doesn't exist, and anything that isn't a file or folder.
 */
export async function insideTarget(root: string, path: string | undefined): Promise<HostTarget> {
  if (path !== undefined && (isAbsolute(path) || path.includes("\0")))
    throw new HostOpenError("path_not_found");
  let base: string;
  try {
    base = await realpath(root);
  } catch {
    throw new HostOpenError("path_not_found");
  }
  const found = await resolveExisting(resolve(base, path ?? "."));
  if (!within(base, found.target)) throw new HostOpenError("path_not_found");
  return found;
}
