import type { ClientApi, ConnectionState } from "@ace/client";
import type { MachinePool } from "@ace/client-worker/machines";
import { arrayEqual, useClient, useConnectionState, useSelection } from "@ace/client-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDaemonSetting } from "./daemon-setting.ts";
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
  const [displayName] = useDaemonSetting("host.displayName");
  const pool = useMachinePool();
  const client = own.client;
  // With a pool, this daemon's identity names it and keeps it from being listed twice.
  const identity = useQuery({
    queryKey: ["machines", "identity", displayName],
    queryFn: async ({ signal }) => {
      if (!client) throw new Error("offline");
      return (await client.request({ type: "host.identity" }, { signal })).identity;
    },
    enabled: client !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data;
  const others = usePoolMachines(pool);
  return useMemo(() => {
    const primary: Machine = identity
      ? {
          ...own,
          id: identity.hostId,
          name: typeof displayName === "string" && displayName ? displayName : identity.displayName,
        }
      : own;
    return [primary, ...others.filter((machine) => machine.id !== identity?.hostId)];
  }, [own, identity, others, displayName]);
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
  return useMemo(
    () => ({
      id: primaryMachineId,
      name: "This machine",
      status: statusOf(state),
      client: state === "ready" ? client : undefined,
      primary: true,
    }),
    [client, state],
  );
}
