import { useEffect, useRef, useState } from "react";
import {
  useAccountMachineConnector,
  type AccountMachine,
  type AccountMachineConnection,
  type AccountMachineState,
} from "@/features/ace-account/index.ts";
import type { AccountOpening } from "@ace/ui-core/fleet-map";

/**
 * Opening machines on the ace account from the Fleet map, each through ace's relay as its row
 * on the overview opens it: how each attempt is going, its connection (for the machine code
 * prompt), and opening one again. Attempts that never opened close when the map goes.
 */
export function useAccountOpenings() {
  const connector = useAccountMachineConnector();
  const [connections, setConnections] = useState<ReadonlyMap<string, AccountMachineConnection>>(
    () => new Map(),
  );
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // Each connection's state as last heard, kept in state so every change renders.
  const [states, setStates] = useState<ReadonlyMap<string, AccountMachineState>>(() => new Map());
  const live = useRef(connections);
  useEffect(() => {
    live.current = connections;
    const heard = (id: string, connection: AccountMachineConnection) =>
      setStates((all) => new Map([...all, [id, connection.get()]]));
    const stops = [...connections].map(([id, connection]) => {
      heard(id, connection);
      return connection.subscribe(() => heard(id, connection));
    });
    return () => stops.forEach((stop) => stop());
  }, [connections]);
  useEffect(
    () => () => {
      for (const connection of live.current.values())
        if (connection.get().kind !== "open") void connection.close().catch(() => {});
    },
    [],
  );

  const open = (machine: AccountMachine) => {
    const existing = connections.get(machine.hostId);
    if (existing) return existing.retry();
    if (!connector || pending.has(machine.hostId)) return;
    setPending((ids) => new Set([...ids, machine.hostId]));
    setFailures((all) => new Map([...all].filter(([id]) => id !== machine.hostId)));
    connector
      .connect({ hostId: machine.hostId, name: machine.name, platform: machine.platform })
      .then(
        (connection) => setConnections((all) => new Map([...all, [machine.hostId, connection]])),
        (error: unknown) =>
          setFailures(
            (all) =>
              new Map([
                ...all,
                [
                  machine.hostId,
                  error instanceof Error ? error.message : "Couldn't open it. Try again.",
                ],
              ]),
          ),
      )
      .finally(() => setPending((ids) => new Set([...ids].filter((id) => id !== machine.hostId))));
  };

  const openings = new Map<string, AccountOpening>();
  for (const id of pending) openings.set(id, { kind: "connecting" });
  for (const [id, message] of failures) openings.set(id, { kind: "failed", message });
  for (const [id, state] of states) {
    openings.set(
      id,
      state.kind === "asking"
        ? { kind: "asking" }
        : state.kind === "failed"
          ? { kind: "failed", message: state.message }
          : { kind: state.kind },
    );
  }
  return {
    /** Whether this window can open account machines at all. */
    available: connector !== undefined,
    openings,
    connection: (hostId: string) => connections.get(hostId),
    /** Its connection's state as last heard. */
    state: (hostId: string) => states.get(hostId),
    open,
  };
}

export type AccountOpenings = ReturnType<typeof useAccountOpenings>;
