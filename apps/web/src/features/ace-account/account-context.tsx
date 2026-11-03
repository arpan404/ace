import { aceAccountClient } from "@ace/client/ace-account";
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { accountSecret } from "@/boot/account-secret.ts";
import { accountOrigin, signInReturnTo } from "@/boot/account-config.ts";
import { hasDesktopBridge } from "@/boot/desktop.ts";
import { authorizeDaemonUrl } from "@/boot/daemon-network.ts";
import { webStorage } from "@/boot/web-storage.ts";
import {
  aceAccountStore,
  type AceAccountBackend,
  type AceAccountState,
  type AceAccountStore,
} from "./session-store.ts";

/**
 * Where ace's account backend is, for a build or a test that supplies its own (the fake mode's
 * in-memory backend). Without one the build's `VITE_ACE_ACCOUNT_URL` is used, and without that
 * there is no account: local use and pairing never need one.
 */
export const AceAccountBackendContext = createContext<
  (() => AceAccountBackend | undefined) | undefined
>(undefined);

function deployedBackend(): AceAccountBackend | undefined {
  const origin = accountOrigin();
  if (!origin) return undefined;
  return {
    origin,
    client: aceAccountClient({
      origin,
      fetch: async (input, init) => {
        await authorizeDaemonUrl(`${origin}/`);
        return fetch(input, init);
      },
    }),
    storage: webStorage(() => sessionStorage),
    secure: accountSecret(),
    returnTo: signInReturnTo({ desktop: hasDesktopBridge(), origin: location.origin }),
  };
}

const StoreContext = createContext<AceAccountStore | undefined>(undefined);

/** One ace session for the whole window, restored as the app starts. */
export function AceAccountProvider(props: { children: ReactNode }) {
  const supplied = use(AceAccountBackendContext);
  const [store] = useState(() => {
    const backend = (supplied ?? deployedBackend)();
    return backend && aceAccountStore(backend);
  });
  useEffect(() => {
    if (!store) return;
    const controller = new AbortController();
    void store.restore(controller.signal);
    return () => controller.abort();
  }, [store]);
  return <StoreContext value={store}>{props.children}</StoreContext>;
}

const none = () => () => {};
const signedOut: AceAccountState = { session: null, restoring: false, error: "", signIn: null };

/** The window's ace account store, or undefined in a build without an account backend. */
export function useAceAccountStore(): AceAccountStore | undefined {
  return use(StoreContext);
}

/** The window's ace session as it changes; signed out when there is no account backend. */
export function useAceAccount(): AceAccountState {
  const store = use(StoreContext);
  return useSyncExternalStore(store?.subscribe ?? none, store?.get ?? (() => signedOut));
}
