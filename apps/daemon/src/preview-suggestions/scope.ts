import { sep } from "node:path";
import type { Listener } from "@ace/preview/detection";

/*
 * Which listening processes belong to which thread. A listener counts for a thread only when
 * its process descends from one of the thread's terminal shells, or runs in the thread's
 * project or worktree directory. Everything else on the machine (databases, system services,
 * other projects, the daemon itself and the provider CLIs, MCP servers and browsers it runs)
 * never does.
 */

export interface ThreadScope {
  threadId: string;
  /** Real paths of the project and worktree roots. */
  roots: readonly string[];
  /** The thread's terminal shells (and actions, which run in terminals). */
  shells: readonly number[];
}

export interface ScopeFacts {
  listeners: readonly Listener[];
  /** Each process's parent. */
  parents: ReadonlyMap<number, number>;
  /** Working directories of the listeners that no shell explains. */
  cwds: ReadonlyMap<number, string>;
  scopes: readonly ThreadScope[];
  /** The daemon's own process. */
  daemon: number;
  /** Ports the daemon serves (its API, the preview gateway). */
  daemonPorts: ReadonlySet<number>;
}

/** How many ancestors are followed before a chain is treated as unrelated. */
const maxDepth = 64;

export function inside(directory: string, root: string): boolean {
  if (!root) return false;
  if (directory === root) return true;
  return directory.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The shell a process descends from, if any. */
export function shellOf(
  pid: number,
  parents: ReadonlyMap<number, number>,
  shells: ReadonlySet<number>,
): number | undefined {
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < maxDepth; depth++) {
    if (shells.has(current)) return current;
    current = parents.get(current);
  }
  return undefined;
}

/**
 * A listener the daemon itself owns: its own process, or a process the daemon started directly
 * that is not a terminal shell (a provider CLI, an MCP server, a browser).
 */
function daemonOwned(listener: Listener, facts: ScopeFacts, shells: ReadonlySet<number>): boolean {
  if (listener.pid === facts.daemon || facts.daemonPorts.has(listener.port)) return true;
  return facts.parents.get(listener.pid) === facts.daemon && !shells.has(listener.pid);
}

function candidates(facts: ScopeFacts, shells: ReadonlySet<number>): Listener[] {
  return facts.listeners.filter(
    (listener) => listener.reach !== "other" && !daemonOwned(listener, facts, shells),
  );
}

/** Listener processes whose directory decides their thread: no shell explains them. */
export function unexplainedPids(facts: Omit<ScopeFacts, "cwds">): number[] {
  const shells = new Set(facts.scopes.flatMap((scope) => scope.shells));
  const pids = new Set<number>();
  for (const listener of candidates({ ...facts, cwds: new Map() }, shells))
    if (shellOf(listener.pid, facts.parents, shells) === undefined) pids.add(listener.pid);
  return [...pids];
}

/** Each thread's listeners, one per port. */
export function scopeListeners(facts: ScopeFacts): Map<string, Listener[]> {
  const shells = new Set(facts.scopes.flatMap((scope) => scope.shells));
  const result = new Map<string, Map<number, Listener>>();
  for (const listener of candidates(facts, shells)) {
    const shell = shellOf(listener.pid, facts.parents, shells);
    const cwd = facts.cwds.get(listener.pid);
    for (const scope of facts.scopes) {
      const owned =
        (shell !== undefined && scope.shells.includes(shell)) ||
        (cwd !== undefined && scope.roots.some((root) => inside(cwd, root)));
      if (!owned) continue;
      const ports = result.get(scope.threadId) ?? new Map<number, Listener>();
      if (!ports.has(listener.port)) ports.set(listener.port, listener);
      result.set(scope.threadId, ports);
    }
  }
  return new Map([...result].map(([threadId, ports]) => [threadId, [...ports.values()]]));
}
