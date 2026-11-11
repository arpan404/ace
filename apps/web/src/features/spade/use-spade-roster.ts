import type { ClientApi } from "@ace/client";
import { spadeRoster, type SpadeAgent } from "@ace/ui-core/spade-chat";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { readAgents, setMainHosted } from "./spade-api.ts";
import { SpadeRequestError } from "./spade-requests.ts";
import { spadeMachineKey, spadeMachineOf, type SpadeMachine } from "./spade-machine.tsx";

export const agentsKey = ["spade", "agents"] as const;

/** A bot as the roster shows it: with the machine it runs on and whether that machine answers. */
export interface RosterBot extends SpadeAgent {
  machine: SpadeMachine;
  /** Its machine is offline: the bot is listed from its last answer, away. */
  away: boolean;
}

/** A machine whose Spade answered: where a new bot can run. */
export interface SpadeHost {
  machine: Machine;
  spade: SpadeMachine;
}

/** A machine's agents, or null when its Spade is off or not there. */
async function machineAgents(client: ClientApi, signal: AbortSignal) {
  try {
    return await readAgents(client, { signal });
  } catch (error) {
    // The daemon answered for Spade: it isn't running there. Anything else is a real failure.
    if (error instanceof SpadeRequestError && error.code !== undefined && !error.unanswered)
      return null;
    throw error;
  }
}

/** Which main agent is Spade: the oldest, from the first machine Spade ran on. */
export function hostOfSpade<T extends { kind: string; createdAt: number }>(agents: readonly T[]) {
  return agents
    .filter((agent) => agent.kind === "main")
    .toSorted((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * Spade and the person's bots on every machine this window reaches (ADR 0127), Spade first,
 * then the rest by latest activity. Each online machine's Spade is read every few seconds (faster
 * while any bot works); an offline machine's bots stay listed from its last answer, as away.
 * Spade, the main bot, shows once: from the machine where it was made first. Any other machine
 * still hosting a main bot is told to stop (`PUT /v1/main`), once.
 */
export function useSpadeRoster(ready: boolean) {
  const machines = useMachines();
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: [...agentsKey, spadeMachineKey(machine)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        machine.client ? machineAgents(machine.client, signal) : Promise.resolve(null),
      // This machine's Spade is read once it runs; another machine's while it is online.
      enabled: machine.client !== undefined && (!machine.primary || ready),
      gcTime: Number.POSITIVE_INFINITY,
      refetchInterval: (query: { state: { data: SpadeAgent[] | null | undefined } }) =>
        query.state.data?.some((agent) => agent.state !== "idle") ? 2_000 : 10_000,
    })),
  });
  const bots = useMemo(() => {
    const all: RosterBot[] = [];
    machines.forEach((machine, index) => {
      const data = results[index]?.data;
      if (!data) return;
      const spade = spadeMachineOf(machine);
      for (const agent of data) all.push({ ...agent, machine: spade, away: !machine.client });
    });
    const main = hostOfSpade(all);
    return spadeRoster(all.filter((agent) => agent.kind !== "main" || agent === main));
  }, [machines, results]);
  const hosts = useMemo(
    () =>
      machines.flatMap((machine, index): SpadeHost[] =>
        machine.client && results[index]?.data ? [{ machine, spade: spadeMachineOf(machine) }] : [],
      ),
    [machines, results],
  );
  useRetireExtraMains(
    machines,
    results.map((result) => result.data),
  );
  const primary = results[machines.findIndex((machine) => machine.primary)];
  return {
    bots,
    hosts,
    /** This machine's roster hasn't answered yet. */
    loading: primary?.data === undefined && primary?.isError !== true,
    error: primary?.data === undefined && primary?.isError === true,
    refetch: () => void primary?.refetch(),
  };
}

function useRetireExtraMains(
  machines: readonly Machine[],
  data: readonly (SpadeAgent[] | null | undefined)[],
) {
  const told = useRef(new Set<string>());
  useEffect(() => {
    const mains = machines.flatMap((machine, index) => {
      const main = data[index]?.find((agent) => agent.kind === "main");
      return main && machine.client
        ? [{ machine, client: machine.client, createdAt: main.createdAt, kind: "main" }]
        : [];
    });
    if (mains.length < 2) return;
    const keep = hostOfSpade(mains);
    for (const other of mains) {
      const key = spadeMachineKey(other.machine);
      if (other === keep || told.current.has(key)) continue;
      told.current.add(key);
      void setMainHosted(other.client, false).catch(() => told.current.delete(key));
    }
  }, [machines, data]);
}
