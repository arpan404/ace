import type { ClientApi } from "@ace/client";
import { spadeHostPlan, spadeRoster, type SpadeAgent } from "@ace/ui-core/spade-chat";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { primaryMachineId, useMachines, type Machine } from "@/lib/machines.ts";
import { readAgents, setMainHosted } from "./spade-api.ts";
import { SpadeRequestError } from "./spade-requests.ts";
import { spadeMachineKey, spadeMachineOf, type SpadeMachine } from "./spade-machine.tsx";

export const agentsKey = ["spade", "agents"] as const;

/** A bot as the roster shows it: with the machine it runs on and whether that machine answers. */
export interface RosterBot extends SpadeAgent {
  machine: SpadeMachine;
  /** Its machine is offline: the bot is listed from its last answer, away. */
  away: boolean;
  /**
   * Its machine is online but its Spade doesn't answer (stopped, off, restarting): the bot is
   * listed from its last answer, and nothing it said it was doing is shown as still going.
   */
  unavailable: boolean;
}

/** A machine whose Spade answered: where a new bot can run. */
export interface SpadeHost {
  machine: Machine;
  spade: SpadeMachine;
}

/** Spade doesn't run on a machine whose daemon answered for it. */
class SpadeNotRunning extends Error {}

/** A machine's agents; throws `SpadeNotRunning` when its daemon says Spade isn't running. */
async function machineAgents(client: ClientApi, signal: AbortSignal) {
  try {
    return await readAgents(client, { signal });
  } catch (error) {
    // The daemon answered for Spade: it isn't running there. Anything else is a real failure.
    if (error instanceof SpadeRequestError && error.code !== undefined && !error.unanswered)
      throw new SpadeNotRunning(error.message);
    throw error;
  }
}

/**
 * Spade and the person's bots on every machine this window reaches (ADR 0127), Spade first,
 * then the rest by latest activity. Each online machine's Spade is read every few seconds (faster
 * while any bot works). A bot whose machine is offline, or whose Spade stopped answering, stays
 * listed from its machine's last answer, as away or unavailable, never as still working. Spade,
 * the main bot, shows once, from the machine `spadeHostPlan` keeps (`useOneSpade` makes it so).
 */
export function useSpadeRoster(ready: boolean) {
  const machines = useMachines();
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: [...agentsKey, spadeMachineKey(machine)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        machine.client
          ? machineAgents(machine.client, signal)
          : Promise.reject(new SpadeNotRunning("offline")),
      // This machine's Spade is read once it runs; another machine's while it is online.
      enabled: machine.client !== undefined && (!machine.primary || ready),
      gcTime: Number.POSITIVE_INFINITY,
      retry: (count: number, error: Error) => !(error instanceof SpadeNotRunning) && count < 2,
      refetchInterval: (query: { state: { data: SpadeAgent[] | undefined } }) =>
        query.state.data?.some((agent) => agent.state !== "idle") ? 2_000 : 10_000,
    })),
  });
  // Whether each machine's Spade answers now: online, its last read fine, and for this window's
  // own machine, Spade reported ready.
  const answering = machines.map(
    (machine, index) =>
      machine.client !== undefined &&
      results[index]?.data !== undefined &&
      results[index]?.isError !== true &&
      (!machine.primary || ready),
  );
  const answerKey = answering.join(",");
  const bots = useMemo(() => {
    const all: RosterBot[] = [];
    machines.forEach((machine, index) => {
      const data = results[index]?.data;
      if (!data) return;
      const spade = spadeMachineOf(machine);
      const away = !machine.client;
      const unavailable = !away && !answering[index];
      for (const agent of data)
        all.push({
          ...agent,
          // What a bot was doing when its Spade last answered isn't true any more.
          ...(away || unavailable ? { state: "idle" as const, status: undefined } : {}),
          machine: spade,
          away,
          unavailable,
        });
    });
    const mains = all
      .filter((agent) => agent.kind === "main")
      .toSorted((a, b) => a.createdAt - b.createdAt || order(a.machine.key, b.machine.key));
    return spadeRoster(all.filter((agent) => agent.kind !== "main" || agent === mains[0]));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `answering` is keyed by answerKey
  }, [machines, results, answerKey]);
  const hosts = useMemo(
    () =>
      machines.flatMap((machine, index): SpadeHost[] =>
        answering[index] ? [{ machine, spade: spadeMachineOf(machine) }] : [],
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `answering` is keyed by answerKey
    [machines, answerKey],
  );
  // Every machine has answered, failed to, or is out of reach (not still connecting): only then
  // may a missing Spade be restored.
  const settled = machines.every(
    (machine, index) =>
      machine.status !== "connecting" &&
      (!machine.client || results[index]?.data !== undefined || results[index]?.isError === true),
  );
  const hosting: SpadeHosting = {
    machines,
    fresh: results.map((result, index) => (answering[index] ? result.data : undefined)),
    settled,
  };
  const primary = results[machines.findIndex((machine) => machine.primary)];
  return {
    bots,
    hosts,
    /** What `useOneSpade` decides from. */
    hosting,
    /** This machine's roster hasn't answered yet. */
    loading: primary?.data === undefined && primary?.isError !== true,
    error:
      primary?.data === undefined &&
      primary?.isError === true &&
      !(primary.error instanceof SpadeNotRunning),
    refetch: () => void primary?.refetch(),
  };
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What this window already told each machine's Spade (`"true"`/`"false"`), once per window. */
const toldClients = new WeakMap<ClientApi, Set<string>>();
function toldBy(client: ClientApi): Set<string> {
  let said = toldClients.get(client);
  if (!said) {
    said = new Set();
    toldClients.set(client, said);
  }
  return said;
}

/** Each machine and its Spade's agents while it answers, and whether every machine has. */
export interface SpadeHosting {
  machines: readonly Machine[];
  fresh: readonly (SpadeAgent[] | undefined)[];
  settled: boolean;
}

/**
 * Keeps Spade on exactly one machine, as every window decides it (`spadeHostPlan`). Waits until
 * every answering machine has its host id, so windows agree, and turns Spade back on only once
 * every online machine has answered. Run once per window, by the Spade panel, which sees every
 * machine the window reaches.
 */
export function useOneSpade({ machines, fresh, settled }: SpadeHosting) {
  useEffect(() => {
    const seen = machines.flatMap((machine, index) => {
      const agents = fresh[index];
      if (!agents || !machine.client) return [];
      const main = agents.find((agent) => agent.kind === "main");
      return [{ machine, client: machine.client, host: machine.id, main }];
    });
    if (seen.length === 0 || seen.some((entry) => entry.host === primaryMachineId)) return;
    const plan = spadeHostPlan(seen);
    const tell = (host: string, enabled: boolean) => {
      const entry = seen.find((candidate) => candidate.host === host);
      if (!entry) return;
      const told = toldBy(entry.client);
      const key = String(enabled);
      if (told.has(key)) return;
      told.add(key);
      void setMainHosted(entry.client, enabled).catch(() => told.delete(key));
    };
    for (const host of plan.disable) tell(host, false);
    // Turning Spade back on waits for every machine's answer: one not heard yet may show it.
    if (plan.enable !== undefined && settled) tell(plan.enable, true);
  }, [machines, fresh, settled]);
}
