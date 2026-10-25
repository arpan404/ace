import { TransferStore, type ClientApi } from "@ace/client";
import type { Transfer } from "@ace/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { useClient } from "./context.ts";

/*
 * One machine's transfers (ADR 0101), followed from the first view that asks: every
 * `transfer.progress` push lands in the store, and each time the connection becomes ready the
 * list is read again, so what moved while the window was away still shows; until it answers the
 * store isn't seeded. Pushes from agents' transfers arrive the same way as the person's own.
 */

const stores = new WeakMap<ClientApi, TransferStore>();

/** The store following `client`'s transfers, started on first use and kept with the client. */
export function transferStore(client: ClientApi): TransferStore {
  const known = stores.get(client);
  if (known) return known;
  const store = new TransferStore();
  stores.set(client, store);
  client.transfers.onProgress((transfer) => store.apply(transfer));
  const connection = client.connectionState();
  let ready = false;
  const check = () => {
    const now = connection.getSnapshot() === "ready";
    if (now && !ready) {
      // Until this connection's list answers, a transfer started while away may be unknown.
      const generation = store.relist();
      client.transfers.list().then(
        (transfers) => store.seed(transfers, generation),
        // Lost with the connection: the reconnect asks again. A machine that can't list
        // transfers still sends their pushes, so then pushes are all there is.
        () => {
          if (connection.getSnapshot() === "ready") store.unlisted(generation);
        },
      );
    }
    ready = now;
  };
  connection.subscribe(check);
  check();
  return store;
}

/** Every transfer this window's machine (or `client`) reports, newest first. */
export function useTransfers(client?: ClientApi): readonly Transfer[] {
  const own = useClient();
  const store = transferStore(client ?? own);
  return useSyncExternalStore(store.subscribe, store.all, store.all);
}

/** The latest transfer of one thread ("Continue on"), whoever started it. */
export function useThreadTransfer(threadId: string | undefined, client?: ClientApi) {
  const own = useClient();
  const store = transferStore(client ?? own);
  const read = useCallback(
    () => (threadId ? store.forThread(threadId) : undefined),
    [store, threadId],
  );
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The latest "Open on" transfer of one project, whoever started it. */
export function useProjectTransfer(workspaceId: string | undefined, client?: ClientApi) {
  const own = useClient();
  const store = transferStore(client ?? own);
  const read = useCallback(
    () => (workspaceId ? store.forProject(workspaceId) : undefined),
    [store, workspaceId],
  );
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Whether the machine's transfer list has answered, so "nothing running" can be trusted. */
export function useTransfersSeeded(client?: ClientApi): boolean {
  const own = useClient();
  const store = transferStore(client ?? own);
  return useSyncExternalStore(store.subscribe, store.seeded, store.seeded);
}

/** Whether this transfer's line was dismissed in this window, and how to dismiss it. */
export function useTransferDismissal(transferId: string | undefined, client?: ClientApi) {
  const own = useClient();
  const store = transferStore(client ?? own);
  const read = useCallback(
    () => (transferId ? store.dismissed(transferId) : false),
    [store, transferId],
  );
  const dismissed = useSyncExternalStore(store.subscribe, read, read);
  const dismiss = useCallback((id: string) => store.dismiss(id), [store]);
  return { dismissed, dismiss };
}
