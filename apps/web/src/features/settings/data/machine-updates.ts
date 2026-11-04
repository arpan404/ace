import type { ClientApi } from "@ace/client";
import type { MachineUpdate, MachineUpdateResult } from "@ace/protocol";
import type { UpdateMachine } from "@ace/ui-core";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Machine } from "@/lib/machines.ts";
import { refusalCode } from "./fleet.ts";

/*
 * Each machine's own update (`machineUpdate.request`, ADR 0113), read through that machine's
 * client and kept current by its `machineUpdate.changed`. A reconnect reads it again, which
 * also re-subscribes the new socket. What a machine last said stays while it's offline, so a
 * machine restarting to update still reads as restarting.
 */

export const machineUpdateKey = (machine: string) => ["machineUpdate", machine] as const;

/** Null when the machine's ace predates remote updates. */
export async function readMachineUpdate(client: ClientApi): Promise<MachineUpdate | null> {
  try {
    const reply = await client.request({ type: "machineUpdate.request", operation: "status" });
    return reply.update ?? null;
  } catch (error) {
    const code = refusalCode(error);
    if (code === "offline" || code === "timeout") throw error;
    return null;
  }
}

/** Ask the machine to update; a refusal comes back as the result's `error`. */
export async function startMachineUpdate(
  client: ClientApi,
  input: { mode: "idle" | "now"; version: string; agents: number },
): Promise<MachineUpdateResult> {
  try {
    return await client.request({ type: "machineUpdate.request", operation: "start", ...input });
  } catch (error) {
    return { type: "machineUpdate.result", requestId: "", ok: false, error: refusalCode(error) };
  }
}

export async function machineUpdateOperation(
  client: ClientApi,
  operation: "check" | "cancel",
): Promise<MachineUpdateResult> {
  try {
    return await client.request({ type: "machineUpdate.request", operation });
  } catch (error) {
    return { type: "machineUpdate.result", requestId: "", ok: false, error: refusalCode(error) };
  }
}

/** Each machine's update status, keyed by machine id. */
export function useMachineUpdates(
  machines: readonly Machine[],
): Map<string, UseQueryResult<MachineUpdate | null> | undefined> {
  const queries = useQueryClient();
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: machineUpdateKey(machine.id),
      queryFn: () => (machine.client ? readMachineUpdate(machine.client) : Promise.resolve(null)),
      enabled: machine.client !== undefined,
      refetchInterval: 60_000,
    })),
  });
  const clients = machines.map((machine) => machine.client);
  useEffect(() => {
    const stops = machines.flatMap((machine) => {
      const client = machine.client;
      if (!client) return [];
      const key = machineUpdateKey(machine.id);
      const connection = client.connectionState();
      return [
        client.onMessage((message) => {
          if (message.type === "machineUpdate.changed") queries.setQueryData(key, message.update);
        }),
        connection.subscribe(() => {
          if (connection.getSnapshot() === "ready")
            void queries.invalidateQueries({ queryKey: key });
        }),
      ];
    });
    return () => {
      for (const stop of stops) stop();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the machines' clients
  }, [queries, ...clients]);
  return new Map(machines.map((machine, index) => [machine.id, results[index]]));
}

/**
 * What this window may do on a machine, from its Fleet devices list: only an administrator can
 * read it, so a list read means admin and a `forbidden` means read-only.
 */
export function accessFrom(devices: UseQueryResult<unknown> | undefined): UpdateMachine["access"] {
  if (devices?.isSuccess) return "admin";
  if (devices?.isError) return refusalCode(devices.error) === "forbidden" ? "read" : "admin";
  return "unknown";
}

/** Every machine as the update rules see it. */
export function updateMachines(
  machines: readonly Machine[],
  updates: ReadonlyMap<string, UseQueryResult<MachineUpdate | null> | undefined>,
  devices: ReadonlyMap<string, UseQueryResult<unknown> | undefined>,
): UpdateMachine[] {
  return machines.map((machine) => ({
    id: machine.id,
    name: machine.name,
    primary: machine.primary,
    online: machine.client !== undefined,
    access: accessFrom(devices.get(machine.id)),
    update: updates.get(machine.id)?.data,
  }));
}
