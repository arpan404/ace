import type { Client } from "@ace/client";
import { createContext, createElement, useContext, type ReactNode } from "react";

const ClientContext = createContext<Client | undefined>(undefined);

/** Supplies the one `@ace/client` instance the app owns. The caller starts and closes it. */
export function ClientProvider(props: { client: Client; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}
export function useClient(): Client {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient needs a <ClientProvider>");
  return client;
}
