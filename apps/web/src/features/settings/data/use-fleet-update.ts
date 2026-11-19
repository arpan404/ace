import type { MachineUpdate, MachineUpdateResult } from "@ace/protocol";
import {
  fleetMachineLine,
  fleetRunFailed,
  fleetRunNextSends,
  fleetRunRetry,
  fleetRunSent,
  fleetUpdateHeadline,
  fleetUpdatePlan,
  loadFleetRun,
  newFleetRun,
  pickedUpdatePlan,
  saveFleetRun,
  updateRefusal,
  type FleetUpdateRun,
  type UpdateMachine,
} from "@ace/ui-core";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useOptionalStorage } from "@/lib/layout.tsx";
import type { Machine } from "@/lib/machines.ts";
import { useClock, useNow } from "@/lib/time.ts";
import {
  machineUpdateKey,
  machineUpdateOperation,
  startMachineUpdate,
  updateMachines,
  useMachineUpdates,
} from "./machine-updates.ts";

/*
 * The fleet's updates for Settings › Fleet: every machine's status, the run this window keeps
 * (in its storage, so it outlives this window's own machine restarting), and the actions. All
 * the deciding is `@ace/ui-core`'s; this sends what it says to send and records the answers.
 */
export function useFleetUpdate(
  machines: readonly Machine[],
  devices: ReadonlyMap<string, UseQueryResult<unknown> | undefined>,
) {
  const storage = useOptionalStorage();
  const clock = useClock();
  const now = useNow();
  const queries = useQueryClient();
  const updates = useMachineUpdates(machines);
  const facts = updateMachines(machines, updates, devices);
  const [run, setRun] = useState<FleetUpdateRun | null>(() => loadFleetRun(storage, clock()));
  const change = (next: (run: FleetUpdateRun) => FleetUpdateRun) =>
    setRun((current) => {
      if (!current) return current;
      const changed = next(current);
      saveFleetRun(storage, changed);
      return changed;
    });
  const flying = useRef(new Set<string>());

  const clientOf = (id: string) => machines.find((machine) => machine.id === id)?.client;
  const factOf = (id: string) => facts.find((machine) => machine.id === id);
  /** Keep what the machine answered, so its row moves on before the push arrives. */
  const heard = (id: string, result: MachineUpdateResult) => {
    if (result.update) queries.setQueryData<MachineUpdate>(machineUpdateKey(id), result.update);
  };

  const ask = async (machine: UpdateMachine, mode: "idle" | "now", version: string) => {
    const client = clientOf(machine.id);
    if (!client)
      return {
        type: "machineUpdate.result",
        requestId: "",
        ok: false,
        error: "offline",
      } satisfies MachineUpdateResult;
    const result = await startMachineUpdate(client, {
      mode,
      version,
      agents: machine.update?.busy ?? 0,
    });
    heard(machine.id, result);
    return result;
  };

  // Ask every machine the run says is due, this window's own machine once the rest have been.
  const factsKey = JSON.stringify(facts);
  useEffect(() => {
    if (!run) return;
    for (const entry of fleetRunNextSends(run, facts, clock())) {
      const machine = factOf(entry.id);
      if (!machine || flying.current.has(entry.id)) continue;
      flying.current.add(entry.id);
      void ask(machine, run.mode, entry.version)
        .then((result) =>
          change((current) =>
            result.ok
              ? fleetRunSent(current, entry.id, clock())
              : fleetRunFailed(
                  current,
                  entry.id,
                  updateRefusal(result.error, machine.name, result.update),
                ),
          ),
        )
        .finally(() => flying.current.delete(entry.id));
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the run and the facts
  }, [run, factsKey]);

  const plan = fleetUpdatePlan(facts);
  return {
    machines: facts,
    plan,
    run,
    headline: fleetUpdateHeadline(facts, run, now, plan),
    /** A machine row's update words. */
    line: (id: string) => {
      const machine = factOf(id);
      return machine ? fleetMachineLine(machine, run, now) : null;
    },
    /** Update all: every machine that may update, each when it's idle (or now). */
    startAll: (mode: "idle" | "now") => {
      const next = newFleetRun({ id: crypto.randomUUID(), plan, mode, now: clock() });
      saveFleetRun(storage, next);
      setRun(next);
    },
    /** Update the machines a person picked, each when it's idle (or now), in Update all's order. */
    startPicked: (ids: ReadonlySet<string>, mode: "idle" | "now") => {
      const picked = pickedUpdatePlan(plan, ids);
      if (picked.targets.length === 0 && picked.cannot.length === 0) return;
      const next = newFleetRun({ id: crypto.randomUUID(), plan: picked, mode, now: clock() });
      saveFleetRun(storage, next);
      setRun(next);
    },
    /**
     * One machine's Update or Try again: inside the run it's asked again there, else on its own.
     * Resolves to the refusal's words, or null when it was asked.
     */
    update: async (id: string, mode: "idle" | "now" = "idle"): Promise<string | null> => {
      const machine = factOf(id);
      const version = machine?.update?.available;
      if (!machine || !version) return null;
      if (run?.machines.some((entry) => entry.id === id) && mode === run.mode) {
        change((current) => fleetRunRetry(current, id, version));
        return null;
      }
      const result = await ask(machine, mode, version);
      return result.ok ? null : updateRefusal(result.error, machine.name, result.update);
    },
    operation: async (id: string, operation: "check" | "cancel") => {
      const client = clientOf(id);
      if (!client) return;
      heard(id, await machineUpdateOperation(client, operation));
    },
  };
}

export type FleetUpdate = ReturnType<typeof useFleetUpdate>;
