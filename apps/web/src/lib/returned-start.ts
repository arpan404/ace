import { readJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

/*
 * Why a new thread's start came back to New thread (its worktree couldn't be made, or the
 * daemon refused it), kept beside the draft it returned so the composer's top strip can say so
 * after the move, and after a reload. Keyed by New thread's draft key (`newThreadDraftKey`).
 */

const ReturnedStart = z.object({
  /** The daemon's short title for the failure ("Git is locked"), when it gave one. */
  title: z.string().min(1).max(256).optional(),
  reason: z.string().min(1).max(1024),
  /** The daemon's failure code (`git_quarantined`), for the strip's own next step. */
  code: z.string().min(1).max(128).optional(),
});
export type ReturnedStart = z.infer<typeof ReturnedStart>;
const storageKey = (draftKey: string) => `ace.returnedStart:${draftKey}`;

export function readReturnedStart(
  storage: KeyValueStorage | undefined,
  draftKey: string,
): ReturnedStart | undefined {
  return readJson(storage, storageKey(draftKey), ReturnedStart.optional(), undefined);
}

/** False when the device couldn't keep it; the draft itself still returns. */
export function saveReturnedStart(
  storage: KeyValueStorage | undefined,
  draftKey: string,
  returned: ReturnedStart,
): boolean {
  try {
    const kept = {
      ...(returned.title ? { title: returned.title.slice(0, 256) } : {}),
      reason: returned.reason.slice(0, 1024),
      ...(returned.code ? { code: returned.code.slice(0, 128) } : {}),
    };
    storage?.setItem(storageKey(draftKey), JSON.stringify(kept));
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
