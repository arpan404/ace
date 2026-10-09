import type { MachineIcon } from "@ace/protocol";
import type { ClientApi, ConnectionState } from "@ace/client";
import type { MachinePool } from "@ace/client-worker/machines";
import { arrayEqual, useClient, useConnectionState, useSelection } from "@ace/client-react";
import { useHostIdentity } from "./host-name.ts";
import { useMemo } from "react";
import { useMachinePool } from "./machine-pool.ts";

/*
 * The machines a picker can target: this window's own daemon first, then every other machine
 * in the client's pool (ADR 0059), each with its live status and, while it is online, the
 * client that reaches it. Requests go to the chosen machine's client and never fall back to
 * another one.
 */

export type MachineStatus = "online" | "connecting" | "offline" | "auth_failed";

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
}

export const primaryMachineId = "primary";

const statusOf = (state: ConnectionState): MachineStatus =>
  state === "ready"
    ? "online"
    : state === "connecting" || state === "reconnecting"
      ? "connecting"
      : "offline";
const noIds: readonly string[] = [];

/** Every machine, this window's daemon first. Without a pool that is the only one. */
export function useMachines(): readonly Machine[] {
  const own = usePrimaryMachine();
  const pool = useMachinePool();
  const others = usePoolMachines(pool);
  return useMemo(() => {
    return [own, ...others.filter((machine) => machine.id !== own.id)];
  }, [own, others]);
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
