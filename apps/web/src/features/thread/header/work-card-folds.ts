import { useCallback, useSyncExternalStore } from "react";

/*
 * Which Work card groups the person folded, remembered on this device across threads and
 * reloads. A group is open until folded.
 */

export type WorkGroup = "environment" | "git" | "running";

const key = "ace.workCard.folded";
const listeners = new Set<() => void>();
let cached: { raw: string | null; folded: ReadonlySet<string> } | undefined;

function read(): ReadonlySet<string> {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    raw = null;
  }
  if (cached?.raw === raw) return cached.folded;
  let folded: ReadonlySet<string> = new Set();
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed))
      folded = new Set(parsed.filter((each): each is string => typeof each === "string"));
  } catch {
    // An unreadable entry starts every group open again.
  }
  cached = { raw, folded };
  return folded;
}

function write(folded: ReadonlySet<string>) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify([...folded]));
  } catch {
    // Storage full or blocked: the fold still applies until reload.
    cached = { raw: JSON.stringify([...folded]), folded };
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    removeEventListener("storage", listener);
  };
};

/** One group's open state and its toggle. */
export function useGroupOpen(group: WorkGroup): [open: boolean, toggle: () => void] {
  const folded = useSyncExternalStore(subscribe, read, read);
  const toggle = useCallback(() => {
    const next = new Set(read());
    if (next.has(group)) next.delete(group);
    else next.add(group);
    write(next);
  }, [group]);
  return [!folded.has(group), toggle];
}
