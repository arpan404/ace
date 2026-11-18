import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import { threadGone } from "../thread-gone.ts";

/**
 * Whether a remote child's parent on this machine is gone: deleted, or never here. Its engine
 * state may already be purged, so nothing about the child can be written to it any more; the
 * child's own ledger row still settles. The rule for a deleted thread is `threadGone`'s.
 */
export function parentGone(store: Pick<Store, "getThread">, parent: ThreadId): boolean {
  return !store.getThread(parent) || threadGone((id) => store.getThread(id), undefined, parent);
}
