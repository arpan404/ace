import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/**
 * Whether a remote child's parent on this machine is gone: deleted, or never here. Its engine
 * state may already be purged, so nothing about the child can be written to it any more; the
 * child's own ledger row still settles.
 */
export function parentGone(store: Pick<Store, "getThread">, parent: ThreadId): boolean {
  const thread = store.getThread(parent);
  return !thread || thread.deletedAt !== undefined;
}
