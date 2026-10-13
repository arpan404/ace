import { readJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

/*
 * Why a new thread's start came back to New thread (its worktree couldn't be made, or the
 * daemon refused it), kept beside the draft it returned so the composer's top strip can say so
 * after the move, and after a reload. Keyed by New thread's draft key (`newThreadDraftKey`).
 */

const Reason = z.string().min(1).max(512);
const storageKey = (draftKey: string) => `ace.returnedStart:${draftKey}`;

export function readReturnedStart(
  storage: KeyValueStorage | undefined,
  draftKey: string,
): string | undefined {
  return readJson(storage, storageKey(draftKey), Reason.optional(), undefined);
}

/** False when the device couldn't keep it; the draft itself still returns. */
export function saveReturnedStart(
  storage: KeyValueStorage | undefined,
  draftKey: string,
  reason: string,
): boolean {
  try {
    storage?.setItem(storageKey(draftKey), JSON.stringify(reason.slice(0, 512)));
    return !!storage;
  } catch {
    return false;
  }
}

export function forgetReturnedStart(storage: KeyValueStorage | undefined, draftKey: string): void {
  try {
    if (storage?.removeItem) storage.removeItem(storageKey(draftKey));
    else storage?.setItem(storageKey(draftKey), "");
  } catch {
    /* A stale reason is cleared again on the next send. */
  }
}
