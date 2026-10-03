import type { Client } from "@ace/client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ConnectionScreen } from "@/features/connect/connection-screen.tsx";
import { DaemonConnectionContext, type DaemonConnection } from "./connection.tsx";
import {
  forgetToken,
  loadTarget,
  saveTarget,
  targetFromFragment,
  type ConnectionStores,
  type DaemonTarget,
} from "./connection-settings.ts";

/**
 * Owns the daemon client. Without a usable target it shows the connection screen; with one it
 * creates a client, starts it and renders the app. Changing the target replaces the client.
 */
export function ConnectionGate(props: {
  stores: ConnectionStores;
  defaultUrl: string;
  createClient(target: DaemonTarget): Client;
  /** `location.hash` at boot, for the daemon's `#token=` hand-off. */
  fragment?: string;
  /** A target handed over by the desktop app's preload bridge; wins over the fragment. */
  handed?: DaemonTarget | undefined;
  onFragmentRead?(): void;
  children(client: Client): ReactNode;
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
  const [client, setClient] = useState<{ client: Client; key: number } | undefined>(undefined);
  useEffect(() => {
    // The client is an external resource with a start/close lifecycle. Creating it here (not
    // in render) keeps StrictMode's mount-unmount-mount from starting a closed client.
    if (!state.target) {
      // oxlint-disable-next-line react/set-state-in-effect
      setClient(undefined);
      return;
    }
    const next = createClient(state.target);
    // oxlint-disable-next-line react/set-state-in-effect
    setClient({ client: next, key: ++generation.current });
    void next.start().catch(() => {
      /* The client reports a fatal state; the shell shows it. */
    });
    const online = () => next.networkOnline(true);
    const offline = () => next.networkOnline(false);
    addEventListener("online", online);
    addEventListener("offline", offline);
    return () => {
      removeEventListener("online", online);
      removeEventListener("offline", offline);
      void next.close();
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
