import type { KeyValueStorage } from "@ace/ui-core";

/*
 * Whether the Work card is open, remembered per thread tree on this device: a main thread, its
 * subagents and the threads its agents delegated (here or on a paired machine) share one
 * choice. Every screen of a tree follows it live, including ones kept mounted in a hidden tab,
 * so opening the card on the main thread shows it on a subagent, and closing it anywhere closes
 * it everywhere in that tree.
 */

const storageKey = "ace.thread.workCardTrees";
/** The single, device-wide choice this replaces. */
const legacyKey = "ace.thread.workCardOpen";
/**
 * Only trees with the card open are kept (closed is the default), the most recently opened
 * last. Past this many the oldest is forgotten and reads as closed again.
 */
export const workCardTreesKept = 200;

export interface WorkCardMemory {
  /** The person left the card open. */
  open(): boolean;
  /** The person opened or closed the card; kept for the tree's other screens. */
  remember(open: boolean): void;
  /** Another screen of the same tree opened or closed the card. */
  subscribe?(listener: () => void): () => void;
}

export interface WorkCardTrees {
  /** One tree's memory, keyed by the tree's main thread id. */
  memory(tree: string): WorkCardMemory;
}

export function createWorkCardTrees(storage: KeyValueStorage | undefined): WorkCardTrees {
  let open = read(storage);
  storage?.removeItem?.(legacyKey);
  const listeners = new Map<string, Set<() => void>>();
  const remember = (tree: string, next: boolean) => {
    const was = open.includes(tree);
    if (was === next) return;
    const rest = open.filter((id) => id !== tree);
    if (next) rest.push(tree);
    open = rest.slice(-workCardTreesKept);
    storage?.setItem(storageKey, JSON.stringify(open));
    for (const listener of listeners.get(tree) ?? []) listener();
  };
  return {
    memory: (tree) => ({
      open: () => open.includes(tree),
      remember: (next) => remember(tree, next),
      subscribe(listener) {
        let set = listeners.get(tree);
        if (!set) listeners.set(tree, (set = new Set()));
        set.add(listener);
        return () => {
          set.delete(listener);
          if (set.size === 0) listeners.delete(tree);
        };
      },
    }),
  };
}

/** The open trees as stored; anything else (an older layout, a hand edit) reads as none. */
function read(storage: KeyValueStorage | undefined): string[] {
  const raw = storage?.getItem(storageKey);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string").slice(-workCardTreesKept)
      : [];
  } catch {
    return [];
  }
}
