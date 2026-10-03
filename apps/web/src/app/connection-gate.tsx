import type { ClientApi } from "@ace/client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ConnectionScreen } from "@/features/connect/index.ts";
import { DaemonConnectionContext, type DaemonConnection } from "@/boot/connection.tsx";
import {
  forgetToken,
  loadTarget,
  saveTarget,
  targetFromFragment,
  type ConnectionStores,
  type DaemonTarget,
} from "@/boot/connection-settings.ts";

/**
 * Owns the daemon client. Without a usable target it shows the connection screen; with one it
 * creates a client, starts it and renders the app. Changing the target replaces the client.
 */
export function ConnectionGate(props: {
  stores: ConnectionStores;
  defaultUrl: string;
  /** A client now, or once it has loaded (the in-page fallback is fetched on demand). */
  createClient(target: DaemonTarget): ClientApi | Promise<ClientApi>;
  /** `location.hash` at boot, for the daemon's `#token=` hand-off. */
  fragment?: string;
  /** A target handed over by the desktop app's preload bridge; wins over the fragment. */
  handed?: DaemonTarget | undefined;
  onFragmentRead?(): void;
  children(client: ClientApi): ReactNode;
}) {
  const { stores, defaultUrl, createClient, fragment, onFragmentRead } = props;
  const [state, setState] = useState(() => {
    const handed =
      props.handed ?? (fragment ? targetFromFragment(fragment, defaultUrl) : undefined);
    if (handed) saveTarget(stores, handed, false);
    const stored = loadTarget(stores, defaultUrl);
    return { target: stored.target, url: stored.url, remembered: stored.remembered };
  });
  useEffect(() => {
    if (fragment) onFragmentRead?.();
  }, [fragment, onFragmentRead]);

  // Each client gets a fresh app tree (router, caches) keyed by its generation.
  const generation = useRef(0);
  const [client, setClient] = useState<{ client: ClientApi; key: number } | undefined>(undefined);
  // An in-page client that failed to load (its chunk never arrived) is a boot failure.
  const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
  useEffect(() => {
    // The client is an external resource with a start/close lifecycle. Creating it here (not
    // in render) keeps StrictMode's mount-unmount-mount from starting a closed client.
    if (!state.target) {
      // oxlint-disable-next-line react-compiler/set-state-in-effect
      setClient(undefined);
      return;
    }
    let current: ClientApi | undefined;
    let replaced = false;
    const adopt = (next: ClientApi) => {
      if (replaced) {
        void next.close();
        return;
      }
      current = next;
      setClient({ client: next, key: ++generation.current });
      void next.start().catch(() => {
        /* The client reports a fatal state; the shell shows it. */
      });
    };
    const created = createClient(state.target);
    // The in-page client loads on demand; a worker-backed one is ready at once.
    if (created instanceof Promise)
      created.then(adopt, (error: unknown) => {
        if (!replaced) setFailure({ error });
      });
    else adopt(created);
    const online = () => current?.networkOnline(true);
    const offline = () => current?.networkOnline(false);
    addEventListener("online", online);
    addEventListener("offline", offline);
    return () => {
      replaced = true;
      removeEventListener("online", online);
      removeEventListener("offline", offline);
      if (current) void current.close();
    };
  }, [state.target, createClient]);

  const connect = useCallback(
    (target: DaemonTarget, remember: boolean) => {
      saveTarget(stores, target, remember);
      setState({ target, url: target.url, remembered: remember });
    },
    [stores],
  );
  const disconnect = useCallback(() => {
    forgetToken(stores);
    setState((previous) => ({ target: undefined, url: previous.url, remembered: false }));
  }, [stores]);
  const connection = useMemo<DaemonConnection>(
    () => ({ mode: "daemon", url: state.url, remembered: state.remembered, connect, disconnect }),
    [state.url, state.remembered, connect, disconnect],
  );

  if (failure) throw failure.error;
  return (
    <DaemonConnectionContext.Provider value={connection}>
      {!state.target ? (
        <ConnectionScreen />
      ) : client ? (
        <Fragment key={client.key}>{props.children(client.client)}</Fragment>
      ) : null}
    </DaemonConnectionContext.Provider>
  );
}
