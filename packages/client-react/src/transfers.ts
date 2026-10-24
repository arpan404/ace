import { TransferStore, type ClientApi } from "@ace/client";
import type { Transfer } from "@ace/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { useClient } from "./context.ts";

/*
 * One machine's transfers (ADR 0099), followed from the first view that asks: every
 * `transfer.progress` push lands in the store, and each time the connection becomes ready the
 * list is read again, so what moved while the window was away still shows. Pushes from agents'
 * transfers arrive the same way as the person's own.
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
    if (now && !ready)
      client.transfers.list().then(
        (transfers) => store.seed(transfers),
        // A machine that can't list transfers yet still sends their pushes.
        () => undefined,
      );
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
