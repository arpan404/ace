import type { MachineIcon, MachinePathKind } from "@ace/protocol";
import type { ClientApi, ConnectionState } from "@ace/client";
import type { MachineEntry } from "@ace/client/machines";
import type { MachinePool } from "@ace/client-worker/machines";
import { arrayEqual, useClient, useConnectionState, useSelection } from "@ace/client-react";
import { useHostIdentity } from "./host-name.ts";
import { createContext, use, useMemo } from "react";
import { useMachinePool } from "./machine-pool.ts";
import { inSpace, useSpaceScope } from "./space-scope.ts";
import type { MachineStatus, MachineVia } from "@ace/ui-core/fleet-map";

export type { MachineStatus, MachineVia };

/*
 * The machines a picker can target: this window's own daemon first, then every other machine
 * in the client's pool (ADR 0059), each with its live status and, while it is online, the
 * client that reaches it. Requests go to the chosen machine's client and never fall back to
 * another one.
 */

export interface Machine {
  /** The daemon's host id; `primaryMachineId` for this window's daemon while it is unnamed. */
  id: string;
  name: string;
  icon?: MachineIcon | undefined;
  status: MachineStatus;
  /** Set only while the machine is online. */
  client: ClientApi | undefined;
  /** This window's own daemon: the one the rest of the app shows. */
  primary: boolean;
  failed?: boolean;
  /**
   * How this window reaches it, from its saved target: straight to an address (LAN, Tailscale),
   * through a relay, or through ace's relay as an account machine. Undefined for this window's own.
   */
  via?: MachineVia | undefined;
  /** The path the connection uses now, when the machine has several (ADR 0114). */
  path?: MachinePathKind | undefined;
}

const viaOf = (target: MachineEntry["target"]): MachineVia =>
  target.kind === "account"
    ? { kind: "account", url: target.relayUrl }
    : { kind: target.kind, url: target.url };

export const primaryMachineId = "primary";

const statusOf = (state: ConnectionState): MachineStatus =>
  state === "ready" ? "online" : state === "connecting" ? "connecting" : "offline";
const noIds: readonly string[] = [];

/**
 * Set by `MachineScope` (`machine-scope.tsx`): below it `useClient()` is another machine's
 * client, so the list read outside it is the one that stays true.
 */
export const ScopedMachines = createContext<
  { machines: readonly Machine[]; machine: Machine } | undefined
>(undefined);

/** Every machine, this window's daemon first. Without a pool that is the only one. */
export function useMachines(): readonly Machine[] {
  const scoped = use(ScopedMachines);
  const own = usePrimaryMachine();
  const pool = useMachinePool();
  const others = usePoolMachines(pool);
  const listed = useMemo(() => {
    return [own, ...others.filter((machine) => machine.id !== own.id)];
  }, [own, others]);
  return scoped?.machines ?? listed;
}

/**
 * The machines whose projects and threads the window's space shows (ADR 0206 §2.4), this
 * window's daemon first when it is one of them: the lists of work read these, while connections,
 * notices and opening a thread still reach every machine.
 */
export function useMachinesInSpace(): readonly Machine[] {
  const machines = useMachines();
  const scope = useSpaceScope();
  return useMemo(
    () => (scope ? machines.filter((machine) => inSpace(scope, machine.id)) : machines),
    [machines, scope],
  );
}

/**
 * Whether the window's space shows this window's own daemon's projects and threads: in an
 * organization's space only when it is one of the organization's hosts (ADR 0206 §2.4).
 */
export function usePrimaryInSpace(): boolean {
  const own = usePrimaryMachine().id;
  return inSpace(useSpaceScope(), own);
}

/** The other machine this view runs against (inside a `MachineScope`), else undefined. */
export function useScopedMachine(): Machine | undefined {
  return use(ScopedMachines)?.machine;
}

function usePoolMachines(pool: MachinePool | undefined): readonly Machine[] {
  const idSelection = useMemo(() => pool?.select(["ids"], (each) => each.ids), [pool]);
  const ids = useSelection(idSelection) ?? noIds;
  const stateSelection = useMemo(
    () =>
      pool?.select(
        ids.map((id) => `machine:${id}`),
        (each) => ids.map((id) => each.machine(id)),
        arrayEqual,
      ),
    [pool, ids],
  );
  const states = useSelection(stateSelection);
  return useMemo(
    () =>
      (states ?? []).flatMap((machine) => {
        if (!pool || !machine) return [];
        const online = machine.status === "online";
        let reach: ClientApi | undefined;
        try {
          reach = online ? pool.client(machine.entry.hostId) : undefined;
        } catch {
          reach = undefined;
        }
        return [
          {
            id: machine.entry.hostId,
            name: machine.entry.displayName,
            icon: machine.entry.icon,
            status: reach ? machine.status : online ? "offline" : machine.status,
            client: reach,
            primary: false,
            failed: !!machine.error,
            via: viaOf(machine.entry.target),
            path: reach ? machine.path : undefined,
          },
        ];
      }),
    [pool, states],
  );
}

/** This window's own daemon, as a target machine. */
export function usePrimaryMachine(): Machine {
  const client = useClient();
  const state = useConnectionState();
  const identity = useHostIdentity();
  return useMemo(
    () => ({
      id: identity?.hostId ?? primaryMachineId,
      name: identity?.displayName ?? "This machine",
      icon: identity?.icon,
      status: statusOf(state),
      client: state === "ready" ? client : undefined,
      primary: true,
    }),
    [client, state, identity],
  );
}
