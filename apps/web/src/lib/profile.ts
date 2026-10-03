import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import * as z from "zod/mini";
import { useLayout } from "./layout.tsx";

/**
 * The person's display name, for the account disc's initials. ace has no user accounts (provider
 * logins belong to the CLIs), so the name is a preference kept on this device only.
 */
const key = "ace.profile.name";
const ProfileName = z.string().check(z.maxLength(80));
const listeners = new WeakMap<KeyValueStorage, Set<() => void>>();

export function profileName(storage: KeyValueStorage | undefined): string {
  return readJson(storage, key, ProfileName, "");
}

export function setProfileName(storage: KeyValueStorage | undefined, name: string): void {
  writeJson(storage, key, name.trim().slice(0, 80));
  if (storage) for (const listener of listeners.get(storage) ?? []) listener();
}

/** The stored name and a setter; every reader on the page updates when it changes. */
export function useProfileName(): [string, (name: string) => void] {
  const { storage } = useLayout();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!storage) return () => {};
      const set = listeners.get(storage) ?? new Set();
      listeners.set(storage, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    [storage],
  );
  const read = () => profileName(storage);
  const name = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((next: string) => setProfileName(storage, next), [storage]);
  return [name, set];
}
