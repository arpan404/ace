import { LocalStore, useLocal } from "../store.ts";

/**
 * Bumped when something in a thread's checkout changed: a file operation this window made, or
 * the daemon's `files.changed` push. The lazy tree lists its open folders again on each bump, so
 * a new or renamed file shows without waiting for the watcher to name its folder.
 */
export const checkoutRefresh = new LocalStore(0);

export function checkoutChanged(): void {
  checkoutRefresh.set((version) => version + 1);
}

const version = (value: number) => value;

export function useCheckoutRefresh(): number {
  return useLocal(checkoutRefresh, version);
}
