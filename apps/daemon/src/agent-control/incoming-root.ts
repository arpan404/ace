import type { Store } from "../store.ts";

/** Incoming ownership survives broker replacement and daemon restarts. */
export function incomingRemoteRoot(store: Store, root: string): boolean {
  return store.atomic((db) => {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='remote_agent_incoming'").get())
      return false;
    return !!db.prepare("SELECT id FROM remote_agent_incoming WHERE thread_id=? LIMIT 1").get(root);
  });
}
