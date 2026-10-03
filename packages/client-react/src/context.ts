import type { ClientApi } from "@ace/client";
import { createContext, createElement, useContext, type ReactNode } from "react";
import { immediate, type NotifyBatch } from "./batch.ts";

const ClientContext = createContext<ClientApi | undefined>(undefined);
const BatchContext = createContext<NotifyBatch>(immediate);

/**
 * Supplies the one `@ace/client` instance the app owns: in-process or running in a worker.
 * The caller starts and closes it.
 */
export function ClientProvider(props: {
  client: ClientApi;
  /** When store changes reach React; `frameBatch(requestAnimationFrame)` in browsers. */
  batch?: NotifyBatch;
  children?: ReactNode;
}) {
  return createElement(
    ClientContext.Provider,
    { value: props.client },
    createElement(BatchContext.Provider, { value: props.batch ?? immediate }, props.children),
  );
}
export function useNotifyBatch(): NotifyBatch {
  return useContext(BatchContext);
}
export function useClient(): ClientApi {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient needs a <ClientProvider>");
  return client;
}
