import { useSyncExternalStore } from "react";

/*
 * Which thread browsers this window shows are driven by an agent, or held privately by a person.
 * The browser tool reports here and the rail's computer-use indicator reads it. The daemon only
 * sends a browser's state to a window that watches it, so this covers the pages open here.
 */

export interface BrowserControl {
  threadId: string;
  url: string;
  controller: "agent" | "human" | "none";
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
      before.controller === control.controller &&
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
