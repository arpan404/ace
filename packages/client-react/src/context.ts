import type { ClientApi } from "@ace/client";
import { createContext, createElement, useContext, type ReactNode } from "react";

const ClientContext = createContext<ClientApi | undefined>(undefined);

/**
 * Supplies the one `@ace/client` instance the app owns: in-process or running in a worker.
 * The caller starts and closes it.
 */
export function ClientProvider(props: { client: ClientApi; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}
export function useClient(): ClientApi {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient needs a <ClientProvider>");
  return client;
}
