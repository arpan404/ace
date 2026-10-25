import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { createContext, createElement, use, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * One shared object per window (a dialog's request, the Home selection), whichever machine's
 * client the view asking for it runs against (ADR 0100). Under the provider every view, inside a
 * `MachineScope` or not, reaches the same one, so a dialog hosted once in the shell hears a menu
 * in another machine's thread. Outside a provider (a view rendered on its own), one per client.
 */
export function perWindow<T>(make: () => T): {
  Provider(props: { children: ReactNode }): ReactNode;
  use(): T;
} {
  const Window = createContext<T | undefined>(undefined);
  const byClient = new WeakMap<ClientApi, T>();
  function Provider(props: { children: ReactNode }) {
    const [value] = useState(make);
    return createElement(Window.Provider, { value }, props.children);
  }
  function useShared(): T {
    const window = use(Window);
    const client = useClient();
    return useMemo(() => {
      if (window) return window;
      let shared = byClient.get(client);
      if (!shared) {
        shared = make();
        byClient.set(client, shared);
      }
      return shared;
    }, [window, client]);
  }
  return { Provider, use: useShared };
}
