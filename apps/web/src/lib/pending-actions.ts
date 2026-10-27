import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { PendingActions, type PendingAction } from "@ace/ui-core";
import { useSyncExternalStore } from "react";

/*
 * Organize actions this window has made that the daemon hasn't confirmed yet (UX audit SY-10).
 * The organize feature adds them and takes them away; the shell's offline notice lists the ones
 * still waiting. Only the list lives here, below both, so the notice stays small. The list
 * itself is the shared one (`@ace/ui-core` `PendingActions`), which the phone's inbox uses too.
 */

export { PendingActions, type PendingAction };

const stores = new WeakMap<ClientApi, PendingActions>();

/** The pending actions of one client: every view in this window shares them. */
export function pendingActionsOf(client: ClientApi): PendingActions {
  let store = stores.get(client);
  if (!store) {
    store = new PendingActions();
    stores.set(client, store);
  }
  return store;
}

/** Every pending organize action, oldest first. */
export function usePendingActions(): readonly PendingAction[] {
  const store = pendingActionsOf(useClient());
  return useSyncExternalStore(store.subscribe, store.all, store.all);
}
