import type { KeyValueStorage } from "@ace/ui-core";
import { createContext, useContext } from "react";

/*
 * The machines the window's space shows (ADR 0206 §1.5, §2.4), for the lists that hold projects
 * and threads. A project or thread is in a space when the machine it lives on is: an
 * organization's space shows its hosts' work, Personal the person's own machines'. The space
 * context (`features/ace-account`) fills it from the one machine-to-space mapping it keeps; only
 * the context lives here, so the foundations can read it.
 */

export interface SpaceScope {
  /** The space shown, for cache keys; undefined while a chosen organization is being checked. */
  space: string | undefined;
  /** The `Machine.id`s in it; none while the space is being checked, so nothing else is drawn. */
  machines: ReadonlySet<string>;
  /**
   * Whether this window's own machine is in it. Kept apart from its id, which changes once the
   * machine names itself: a list never drops this machine's work for the moment between.
   */
  primary: boolean;
}

/** Personal's id, as `features/ace-account` names it. */
export const personalSpaceId = "personal";

const Context = createContext<SpaceScope | undefined>(undefined);

export const SpaceScopeProvider = Context.Provider;

/** The window's space scope; undefined in a build without spaces, where every machine shows. */
export function useSpaceScope(): SpaceScope | undefined {
  return useContext(Context);
}

/** Whether `scope` shows the work on machine `machineId`. */
export const inSpace = (scope: SpaceScope | undefined, machineId: string): boolean =>
  !scope || scope.machines.has(machineId);

/** The part of a cache key that names the space, so one space's rows are never read in another. */
export const spaceKey = (scope: SpaceScope | undefined): string =>
  scope ? (scope.space ?? "checking") : "all";

/**
 * `storage` as one space keeps it: an organization's keys carry its id, so what a device keeps
 * for one organization's machines is never read in another space. Personal, and a build without
 * spaces, keep the keys they always had, so nothing kept before spaces is lost. Nothing is ever
 * deleted on a switch.
 */
export function spaceStorage(
  storage: KeyValueStorage | undefined,
  scope: SpaceScope | undefined,
): KeyValueStorage | undefined {
  const space = scope?.space;
  if (!storage || !scope || space === personalSpaceId) return storage;
  const named = (key: string) => `${key}@space:${space ?? "checking"}`;
  return {
    ...(storage.durable === undefined ? {} : { durable: storage.durable }),
    getItem: (key) => storage.getItem(named(key)),
    setItem: (key, value) => storage.setItem(named(key), value),
    removeItem: (key) => storage.removeItem?.(named(key)),
  };
}
