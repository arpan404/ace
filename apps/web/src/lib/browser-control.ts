import { useSyncExternalStore } from "react";

/*
 * Which thread browsers this window shows have an agent working in them, or a tab the person
 * keeps agents out of.
 * The browser tool reports here and the rail's computer-use indicator reads it. The daemon only
 * sends a browser's state to a window that watches it, so this covers the pages open here.
 */

export interface BrowserControl {
  threadId: string;
  url: string;
  /** An agent is working in one of the thread's tabs. */
  agent: boolean;
  /** The tab the person views is one they keep agents out of. */
  private: boolean;
}

let controls: ReadonlyMap<string, BrowserControl> = new Map();
const listeners = new Set<() => void>();

/** Report a thread's browser (undefined once no view shows it). */
export function reportBrowserControl(threadId: string, control: BrowserControl | undefined) {
  const before = controls.get(threadId);
  if (
    before === control ||
    (before &&
      control &&
      before.url === control.url &&
      before.agent === control.agent &&
      before.private === control.private)
  )
    return;
  const next = new Map(controls);
  if (control) next.set(threadId, control);
  else next.delete(threadId);
  controls = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useBrowserControls(): ReadonlyMap<string, BrowserControl> {
  return useSyncExternalStore(
    subscribe,
    () => controls,
    () => controls,
  );
}
