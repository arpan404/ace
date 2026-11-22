import { useSyncExternalStore } from "react";

/*
 * Show work in chat (Settings › Spade), remembered on this device: off, the chat shows what is
 * said and what needs the person, and each reply's work (its steps, the notes it had in mind)
 * opens from that reply's More menu; on, every reply's work shows under it as before. A damaged
 * value is off.
 */

const key = "ace.spade.show-work.v1";
const listeners = new Set<() => void>();

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

function read(): boolean {
  try {
    return storage()?.getItem(key) === "on";
  } catch {
    return false;
  }
}

/** Whether every reply's work shows in the chat; off unless the person turned it on. */
export function useShowWork(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      // Another window changing it.
      const changed = (event: StorageEvent) => event.key === key && listener();
      window.addEventListener("storage", changed);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", changed);
      };
    },
    read,
    () => false,
  );
}

/** Turns Show work in chat on or off on this device. */
export function setShowWork(on: boolean): void {
  try {
    if (on) storage()?.setItem(key, "on");
    else storage()?.removeItem(key);
  } catch {
    // Storage off: nothing to remember it in.
  }
  for (const listener of listeners) listener();
}
