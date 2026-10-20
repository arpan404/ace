import { ClientError, type ClientApi } from "@ace/client";
import { bindTerminalEndDelivery } from "@/features/panels/index.ts";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { watchDesktopTarget } from "@/boot/desktop.ts";
import { ConnectionScreen } from "@/features/connect/index.ts";
import { StartupPending } from "@/features/startup/index.ts";
import { deviceId } from "@/boot/device-id.ts";
import {
  DaemonConnectionContext,
  type ConnectionProblem,
  type ConnectionStatus,
  type DaemonConnection,
} from "@/boot/connection.tsx";
import {
  forgetToken,
  loadTarget,
  saveTarget,
  type ConnectionStores,
  type DaemonTarget,
} from "@/boot/connection-settings.ts";
import { handoffFromFragment, type Handoff } from "@/boot/fragment-handoff.ts";
import { forgetKnownHost, knownHost, rememberHost } from "@/boot/known-host.ts";

/** How long a first attempt may take before the screen says it can't reach the daemon. */
export const firstAttemptMs = 6_000;
/** How long a welcomed client may take to identify its host before the screen reports it. */
export const identityMs = 10_000;

type Schedule = (delayMs: number, run: () => void) => () => void;
const timers: Schedule = (delayMs, run) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

interface GateState {
  target: DaemonTarget | undefined;
  url: string;
  remembered: boolean;
  pending?: Extract<Handoff, { kind: "confirm" }> | undefined;
  /** The person is changing the address or token: no client runs. */
  editing: boolean;
  problem?: ConnectionProblem | undefined;
  /** The client's own account of the problem, shown with it; undefined whenever `problem` is. */
  detail?: string | undefined;
  /** Bumped by Try again: the same target with a fresh client. */
  attempt: number;
  /**
   * The connection screen is already on screen. A target found at boot connects behind the
   * splash instead, so a window that can connect opens straight into the app.
   */
  shown: boolean;
}

/** One attempt at one target: a client is made for it and shown only while it is current. */
interface ClientRequest {
  target: DaemonTarget;
  attempt: number;
}

/** Where one client got to before its first welcome. */
type Progress =
  | { kind: "connecting" }
  | { kind: "starting" }
  | { kind: "unreachable"; offline: boolean; mismatch?: boolean }
  | { kind: "ready"; hostId: string };

/**
 * What the app is opened for: the target and its host, the one that verified itself there or,
 * until it does, the one it verified as last time (the app then paints what was kept for it).
 */
export interface GateConnection {
  target: DaemonTarget;
  hostId: string;
}

function problemOf(code: ClientError["code"] | undefined): ConnectionProblem {
  return code === "auth" || code === "identity" || code === "protocol" || code === "storage"
    ? code
    : "failed";
}

/** The error's message when it says more than its code. */
function detailOf(error: ClientError | undefined): string | undefined {
  return error && error.message !== error.code ? error.message : undefined;
}

/**
 * Owns the daemon client. Without a usable target it shows the connection screen; with one it
 * creates a client, starts it and renders the app once the daemon has welcomed it and named its
 * host, keeping the app mounted through later reconnects. A target whose host is known from an
 * earlier visit opens the app at once, on what this device kept, while the daemon answers (the
 * shell's notice says how the connection is going). A target that can't be reached at a first
 * visit, or that the daemon refuses at any time before its welcome, returns to the connection
 * screen with the reason. Changing the target replaces the client.
 */
export function ConnectionGate(props: {
  stores: ConnectionStores;
  defaultUrl: string;
  /** A client now, or once it has loaded (the in-page fallback is fetched on demand). */
  createClient(target: DaemonTarget): ClientApi | Promise<ClientApi>;
  /** Forget the daemon a target's saved work is pinned to (see `forgetDaemonIdentity`). */
  forgetIdentity?(target: DaemonTarget): Promise<void>;
  /** `location.hash` at boot, for the daemon's `#token=` hand-off. */
  fragment?: string;
  /** A target handed over by the desktop app's preload bridge; wins over the fragment. */
  handed?: DaemonTarget | undefined;
  /** Inside the desktop app, whose daemon nobody starts by hand. */
  desktop?: boolean;
  pairingLink?: string | undefined;
  /** When the first-attempt deadline runs; injected by tests. */
  schedule?: Schedule;
  onFragmentRead?(): void;
  children(client: ClientApi, connection: GateConnection): ReactNode;
}) {
  const { stores, defaultUrl, createClient, fragment, onFragmentRead } = props;
  const schedule = props.schedule ?? timers;
  const [state, setState] = useState<GateState>(() => {
    // The desktop bridge is trusted; a link is taken only as far as `handoffFromFragment` allows.
    const handoff: Handoff = props.handed
      ? { kind: "accept", target: props.handed }
      : fragment
        ? handoffFromFragment(stores, fragment, defaultUrl)
        : { kind: "none" };
    if (handoff.kind === "accept") saveTarget(stores, handoff.target, false);
    const stored = loadTarget(stores, defaultUrl);
    // The desktop's target as handed, with the identity of its own daemon, which is never saved.
    const target = props.handed ?? stored.target;
    return {
      target: props.pairingLink === undefined ? target : undefined,
      url: stored.url,
      remembered: stored.remembered,
      pending: handoff.kind === "confirm" ? handoff : undefined,
      editing: false,
      attempt: 0,
      shown: !stored.target || handoff.kind === "confirm",
    };
  });
  // Only the app-managed handoff follows the supervisor. Manual selection owns its target.
  const managed = useRef(props.handed !== undefined);
  const adoptDesktop = useCallback(
    (target: DaemonTarget) => {
      if (!managed.current) return;
      saveTarget(stores, target, false);
      setState((previous) => {
        const current = previous.target;
        if (
          current?.url === target.url &&
          current.token === target.token &&
          current.pairedDeviceId === target.pairedDeviceId &&
          current.localHostId === target.localHostId
        )
          return previous;
        return {
          ...previous,
          target,
          url: target.url,
          remembered: false,
          editing: false,
          problem: undefined,
          detail: undefined,
          attempt: previous.attempt + 1,
        };
      });
    },
    [stores],
  );
  useEffect(() => {
    if (props.handed) adoptDesktop(props.handed);
  }, [props.handed, adoptDesktop]);
  useEffect(
    () => (props.desktop ? watchDesktopTarget(adoptDesktop) : undefined),
    [props.desktop, adoptDesktop],
  );
  // Nothing connects while a link waits for an answer or the person edits the target.
  const active = state.pending || state.editing ? undefined : state.target;
  useEffect(() => {
    if (fragment) onFragmentRead?.();
  }, [fragment, onFragmentRead]);

  // Each client gets a fresh app tree (router, caches) keyed by its generation.
  const generation = useRef(0);
  // Each client is tied to the request it was made for. When the target changes, the old one
  // is closed and, being for another request, is never shown again, even while the new
  // client is still loading.
  const [installed, setClient] = useState<
    | {
        client: ClientApi;
        key: number;
        progress: Progress;
        request: ClientRequest;
        /** The host this target verified as before: the app opens for it before the welcome. */
        known: string | undefined;
      }
    | undefined
  >(undefined);
  // An in-page client that failed to load (its chunk never arrived) is a boot failure.
  const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
  // One request per attempt: Try again asks for the same target again, with a fresh client.
  const attempt = state.attempt;
  const request = useMemo<ClientRequest | undefined>(
    () => active && { target: active, attempt },
    [active, attempt],
  );
  const client = installed && installed.request === request ? installed : undefined;
  useEffect(() => {
    // The client is an external resource with a start/close lifecycle. Creating it here (not
    // in render) keeps StrictMode's mount-unmount-mount from starting a closed client.
    if (!request) {
      // oxlint-disable-next-line react-compiler/set-state-in-effect
      setClient(undefined);
      return;
    }
    let current: ClientApi | undefined;
    let replaced = false;
    const stops: (() => void)[] = [];
    const device = request.target.pairedDeviceId ?? deviceId();
    const refuse = (error: ClientError | undefined) => {
      const problem = problemOf(error?.code);
      // A refused token or another daemon: the next load waits for an answer before opening.
      if (stores.local && (problem === "auth" || problem === "identity"))
        forgetKnownHost(stores.local, request.target, device);
      const detail = detailOf(error);
      // The screen names the problem; the console keeps the client's own words for support.
      console.error(`ace: connection stopped (${error?.code ?? "unknown"})`, detail ?? "");
      setState((previous) => ({ ...previous, editing: true, problem, detail, shown: true }));
    };
    const adopt = (next: ClientApi) => {
      if (replaced) {
        void next.close();
        return;
      }
      current = next;
      const terminalCloses = bindTerminalEndDelivery(next);
      stops.push(terminalCloses.release);
      const key = ++generation.current;
      const progress = (value: Progress) =>
        setClient((previous) =>
          previous?.key === key && previous.progress.kind !== "ready"
            ? { ...previous, progress: value }
            : previous,
        );
      const known = stores.local ? knownHost(stores.local, request.target, device) : undefined;
      setClient({ client: next, key, progress: { kind: "connecting" }, request, known });
      let welcomed = false;
      const states = next.connectionState();
      const follow = () => {
        const now = states.getSnapshot();
        if (now === "ready") {
          if (!welcomed) {
            // The app opens only once the host is identified. A reply this client can't read,
            // or no identity in time, is a failure with Try again rather than an endless splash.
            let identified = false;
            const stopWaiting = schedule(identityMs, () => {
              if (identified || replaced) return;
              refuse(
                new ClientError(
                  "timeout",
                  `ace answered but didn't say which machine it is within ${identityMs / 1000}s.`,
                ),
              );
            });
            stops.push(stopWaiting);
            terminalCloses.identified.then(
              (hostId) => {
                identified = true;
                stopWaiting();
                if (replaced) return;
                if (stores.local) rememberHost(stores.local, request.target, device, hostId);
                if (next.state === "ready") progress({ kind: "ready", hostId });
              },
              (error: unknown) => {
                stopWaiting();
                if (!identified && !replaced)
                  refuse(error instanceof ClientError ? error : undefined);
              },
            );
          } else
            void terminalCloses.identified.then(
              (hostId) => {
                if (!replaced && next.state === "ready") progress({ kind: "ready", hostId });
              },
              () => {},
            );
          welcomed = true;
        } else if (!welcomed && now === "starting") {
          progress({ kind: "starting" });
        } else if (now === "fatal") {
          // Before the first welcome every refusal is shown here; afterwards only a rejected
          // token or another daemon is (the shell's notice says the rest), since the person
          // must paste another token or decide to forget the daemon they met.
          if (!welcomed || next.error?.code === "auth" || next.error?.code === "identity")
            refuse(next.error);
        } else if (!welcomed && now === "reconnecting")
          progress({
            kind: "unreachable",
            offline: false,
            mismatch: next.error?.code === "version_mismatch",
          });
        // A client also reads "offline" before it starts; only a network that is down counts.
        else if (!welcomed && now === "offline" && globalThis.navigator?.onLine === false)
          progress({ kind: "unreachable", offline: true });
      };
      stops.push(states.subscribe(follow));
      stops.push(
        schedule(firstAttemptMs, () => {
          if (!welcomed && next.state !== "starting")
            progress({
              kind: "unreachable",
              offline: false,
              mismatch: next.error?.code === "version_mismatch",
            });
        }),
      );
      follow();
      void next.start().catch(() => {
        /* The client reports a fatal state, which `follow` shows. */
      });
    };
    const created = createClient(request.target);
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
      for (const stop of stops) stop();
      removeEventListener("online", online);
      removeEventListener("offline", offline);
      if (current) void current.close();
    };
  }, [request, createClient, schedule, stores]);

  const connect = useCallback(
    (target: DaemonTarget, remember: boolean) => {
      managed.current = false;
      saveTarget(stores, target, remember);
      setState((previous) => ({
        target,
        url: target.url,
        remembered: remember,
        editing: false,
        attempt: previous.attempt + 1,
        shown: true,
      }));
    },
    [stores],
  );
  const retry = useCallback(
    () =>
      setState((previous) => ({
        ...previous,
        editing: false,
        problem: undefined,
        detail: undefined,
        attempt: previous.attempt + 1,
        shown: true,
      })),
    [],
  );
  const edit = useCallback(() => {
    managed.current = false;
    setState((previous) => ({
      ...previous,
      editing: true,
      problem: undefined,
      detail: undefined,
      shown: true,
    }));
  }, []);
  const disconnect = useCallback(() => {
    managed.current = false;
    forgetToken(stores);
    setState((previous) => ({
      target: undefined,
      url: previous.url,
      remembered: false,
      editing: false,
      attempt: previous.attempt,
      shown: true,
    }));
  }, [stores]);
  const forget = props.forgetIdentity;
  const failedTarget = state.problem === "identity" ? state.target : undefined;
  const forgetIdentity = useMemo(
    () =>
      forget && failedTarget
        ? () => {
            void forget(failedTarget).then(retry, (error: unknown) => {
              console.error("ace: couldn't forget the daemon this window met before", error);
              setState((previous) => ({ ...previous, problem: "storage", detail: undefined }));
            });
          }
        : undefined,
    [forget, failedTarget, retry],
  );
  const pending = state.pending;
  const handoff = useMemo(
    () =>
      pending && {
        url: pending.target.url,
        reason: pending.reason,
        accept: () => connect(pending.target, false),
        decline: () => setState((previous) => ({ ...previous, pending: undefined })),
      },
    [pending, connect],
  );
  const progress = client?.progress;
  const status = useMemo<ConnectionStatus>(() => {
    if (!active) return { kind: "editing", problem: state.problem, detail: state.detail };
    if (!progress || progress.kind === "connecting") return { kind: "connecting" };
    return progress;
  }, [active, state.problem, state.detail, progress]);
  const connection = useMemo<DaemonConnection>(
    () => ({
      mode: "daemon",
      url: state.url,
      remembered: state.remembered,
      token: state.target?.token,
      pairedDeviceId: state.target?.pairedDeviceId,
      status,
      desktop: props.desktop,
      pairingLink: props.pairingLink,
      connect,
      retry,
      edit,
      disconnect,
      forgetIdentity,
      endpoint: active && {
        kind: "daemon",
        target: active,
        deviceId: active.pairedDeviceId ?? deviceId(),
      },
      handoff,
    }),
    [
      state.url,
      state.remembered,
      state.target,
      status,
      props.desktop,
      props.pairingLink,
      active,
      connect,
      retry,
      edit,
      disconnect,
      forgetIdentity,
      handoff,
    ],
  );

  if (failure) throw failure.error;
  // The verified host once it has identified itself; before that, a host this target verified
  // as before: the app opens on what this device kept for it while the daemon answers. Any
  // refusal still returns to the connection screen, since it ends the request.
  const opened = client?.progress.kind === "ready" ? client.progress.hostId : client?.known;
  // Connecting behind the startup screen: nothing of the gate's own until the daemon answers or
  // doesn't. The desktop's own daemon reconnecting at boot stays there too ("Reconnecting…"),
  // with Connect manually once it stalls, rather than dropping to the address form. A daemon of
  // another version is said on the connection screen instead: waiting won't fix it.
  const behindSplash =
    !state.shown &&
    (status.kind === "connecting" ||
      (status.kind === "unreachable" &&
        !status.mismatch &&
        props.desktop === true &&
        props.handed !== undefined));
  const manually = props.desktop ? edit : undefined;
  return (
    <DaemonConnectionContext.Provider value={connection}>
      {client && opened ? (
        // Opened for a host it then turns out isn't there: reopened for the one that is.
        <Fragment key={`${client.key}:${opened}`}>
          {props.children(client.client, { target: client.request.target, hostId: opened })}
        </Fragment>
      ) : status.kind === "starting" ? (
        <StartupPending state="starting" onConnectManually={manually} />
      ) : behindSplash ? (
        <StartupPending
          state={status.kind === "unreachable" ? "reconnecting" : "connecting"}
          onConnectManually={manually}
        />
      ) : (
        <ConnectionScreen />
      )}
    </DaemonConnectionContext.Provider>
  );
}
