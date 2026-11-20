import { useSyncExternalStore } from "react";

/*
 * VS Code's Tab-moves-focus mode: while on, Tab and Shift+Tab leave the editor for the next or
 * previous control instead of indenting, so a keyboard is never trapped in it. One switch for
 * the window, as VS Code's is: every editor and every status line read the same one.
 */

let on = false;
const listeners = new Set<() => void>();

export const tabFocus = {
  get on(): boolean {
    return on;
  },
  set(next: boolean): void {
    if (next === on) return;
    on = next;
    for (const listener of listeners) listener();
  },
  toggle(): void {
    this.set(!on);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Whether Tab moves focus now, re-rendering when the switch flips. */
export function useTabMovesFocus(): boolean {
  return useSyncExternalStore(tabFocus.subscribe, () => tabFocus.on);
}

/** Ctrl+M toggles the mode; on macOS, where Ctrl+M is a control character, Ctrl+Shift+M. */
export function isTabFocusToggle(
  event: { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean },
  mac: boolean,
): boolean {
  return (
    event.code === "KeyM" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    event.shiftKey === mac
  );
}
