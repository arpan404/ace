import { PermissionMode, ProviderKind, WorktreeBase } from "@ace/protocol";
import { readJson, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { Choices } from "./choices.ts";
import { ComposerDraftSchema } from "@/features/thread/index.ts";

const Preparation = z.object({
  owner: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  project: z.string(),
  skill: z.string().optional(),
  choices: Choices,
  settingsResolved: z.boolean().optional(),
  provider: ProviderKind.optional(),
  permission: PermissionMode.optional(),
  base: z.union([WorktreeBase, z.string()]).optional(),
  draftId: z.string().optional(),
  scopeEpoch: z.number().int().nonnegative().optional(),
  attachmentsUnavailable: z.boolean().optional(),
  // A discard spans two storage keys. Keep content here until both deletions commit.
  discardRecovery: ComposerDraftSchema.optional(),
  title: z.string(),
});
export type Preparation = z.infer<typeof Preparation>;
const Records = z.array(z.tuple([z.string(), Preparation]));
const storageKey = (host: string) => `ace.preparations:${host}`;
export const preparationKey = (host: string, project: string, skill?: string) =>
  `new:${JSON.stringify([host, project, skill ?? ""])}`;

// Notifications and failed-write notices stay in memory; durable rows remain the authority.
const listeners = new Set<() => void>();
const failures = new WeakMap<KeyValueStorage, Set<string>>();
export function preparationSaveFailed(storage: KeyValueStorage | undefined, key: string): boolean {
  return !storage || failures.get(storage)?.has(key) === true;
}
function savedResult(storage: KeyValueStorage | undefined, key: string, saved: boolean): boolean {
  if (storage) {
    let rejected = failures.get(storage);
    if (!rejected) {
      rejected = new Set();
      failures.set(storage, rejected);
    }
    const before = rejected.has(key);
    if (saved) rejected.delete(key);
    else rejected.add(key);
    if (before !== !saved) changed();
  }
  return saved;
}
let revision = 0;
function changed() {
  revision++;
  const pending = [...listeners];
  for (const listener of pending) listener();
}
function external(event: StorageEvent) {
  if (event.key?.startsWith("ace.preparations:") || event.key === null) changed();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) addEventListener("storage", external);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) removeEventListener("storage", external);
  };
}
const snapshot = () => revision;
export function usePreparationsChanged() {
  return useSyncExternalStore(subscribe, snapshot);
}
export function preparations(storage: KeyValueStorage | undefined, host: string) {
  return readJson(storage, storageKey(host), Records, []);
}
export function preparation(storage: KeyValueStorage | undefined, host: string, key: string) {
  return preparations(storage, host).find(([id]) => id === key)?.[1];
}
export function savePreparation(
  storage: KeyValueStorage | undefined,
  host: string,
  key: string,
  value: Preparation | undefined,
) {
  const current = preparations(storage, host);
  const previous = current.find(([id]) => id === key)?.[1];
  const rows = current.filter(([id]) => id !== key);
  if (value && rows.length >= 50) return savedResult(storage, key, false);
  if (value) rows.push([key, { ...value, revision: (previous?.revision ?? 0) + 1 }]);
  if (!storage || storage.durable === false) return savedResult(storage, key, false);
  try {
    storage.setItem(storageKey(host), JSON.stringify(rows));
    changed();
    return savedResult(storage, key, true);
  } catch {
    return savedResult(storage, key, false);
  }
}

/** #524 retained pre-preparation uploads under their original project-scoped draft key. */
export function legacyDraftScope(
  storage: KeyValueStorage | undefined,
  host: string,
  key: string,
): string | undefined {
  return readJson(
    storage,
    `ace.composer.scope:${JSON.stringify([host, key])}`,
    z.string().optional(),
    undefined,
  );
}
