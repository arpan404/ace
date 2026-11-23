import { useSyncExternalStore } from "react";

/*
 * Prototype (ADR 0217): which lane is open and whether the task list shows as a panel beside the
 * chat. Kept in memory, seeded once from the address (`?lane=lane-invoice`, `?tasks=panel`,
 * `?tasks=popover`) so each mockup can be opened directly.
 */

export interface LanesPlace {
  lane: string | undefined;
  panel: boolean;
  popover: boolean;
}

const params = new URLSearchParams(globalThis.location?.search ?? "");
let place: LanesPlace = {
  lane: params.get("lane") ?? undefined,
  panel: params.get("tasks") === "panel",
  popover: params.get("tasks") === "popover",
};
const listeners = new Set<() => void>();

export function setLanesPlace(change: Partial<LanesPlace>) {
  place = { ...place, ...change };
  for (const listener of listeners) listener();
}

export function useLanesPlace(): LanesPlace {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => place,
  );
}
