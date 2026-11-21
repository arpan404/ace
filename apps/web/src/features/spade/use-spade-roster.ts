import type { ClientApi } from "@ace/client";
import {
  newestSpadeHost,
  spadeRoster,
  spadeWithLive,
  type SpadeAgent,
  type SpadeMainState,
} from "@ace/ui-core/spade-chat";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Machine } from "@/lib/machines.ts";
import { useSpaceMachines } from "@/features/ace-account/index.ts";
import { readAgents } from "./spade-api.ts";
import { readMain } from "./spade-move-api.ts";
import { SpadeRequestError } from "./spade-requests.ts";
import { spadeMachineKey, spadeMachineOf, type SpadeMachine } from "./spade-machine.tsx";
import { liveRowKey, useLiveRows } from "./spade-live-rows.ts";

export const agentsKey = ["spade", "agents"] as const;
/** Each machine's answer about where Spade lives (`GET /v1/main`). */
export const mainKey = ["spade", "main"] as const;

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
 * the main bot, shows once, from the machine the fleet chose to host it (ADR 0187), as away while
 * that machine is; `useSpadeHost` copies the choice to every machine.
 */
export function useSpadeRoster(ready: boolean) {
  // Only the window's space's machines: an organization's shared bots never list in Personal.
  const machines = useSpaceMachines();
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
        query.state.data?.some((agent) => agent.state !== "idle" || agent.move !== undefined)
          ? 2_000
          : 10_000,
    })),
  });
  const mains = useQueries({
    queries: machines.map((machine) => ({
      queryKey: [...mainKey, spadeMachineKey(machine)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        machine.client
          ? readMain(machine.client, { signal })
          : Promise.reject(new SpadeNotRunning("offline")),
      enabled: machine.client !== undefined && (!machine.primary || ready),
      gcTime: Number.POSITIVE_INFINITY,
      retry: false,
      refetchInterval: 30_000,
    })),
  });
  const records = mains.map((main) => main.data);
  const recordKey = records.map((main) => JSON.stringify(main?.host ?? null)).join(",");
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
  // A bot whose conversation is open here reads as its chat shows it (`spadeLiveAgent`).
  const live = useLiveRows().bots;
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
          ...(away || unavailable
            ? // What a bot was doing when its Spade last answered isn't true any more.
              { ...agent, state: "idle" as const, status: undefined }
            : spadeWithLive(agent, live.get(liveRowKey(spade.key, agent.conversation)))),
          machine: spade,
          away,
          unavailable,
        });
    });
    const mainOn = (machine: Machine) =>
      all.find((agent) => agent.kind === "main" && agent.machine.key === spadeMachineKey(machine));
    // Spade is the main bot of the machine the fleet chose, read last time if it is away now.
    // Before any choice, the oldest main of those answering, as each machine still decides.
    const choice = newestSpadeHost(records.map((main) => main?.host));
    const chosen = choice && machines.find((machine) => machine.id === choice.host);
    const shown = choice
      ? chosen && mainOn(chosen)
      : all
          .filter(
            (agent) =>
              agent.kind === "main" &&
              machines.some(
                (machine, index) =>
                  answering[index] && spadeMachineKey(machine) === agent.machine.key,
              ),
          )
          .toSorted((a, b) => a.createdAt - b.createdAt || order(a.machine.key, b.machine.key))[0];
    return spadeRoster(all.filter((agent) => agent.kind !== "main" || agent === shown));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by answerKey and recordKey
  }, [machines, results, answerKey, recordKey, live]);
  const hosts = useMemo(
    () =>
      machines.flatMap((machine, index): SpadeHost[] =>
        answering[index] ? [{ machine, spade: spadeMachineOf(machine) }] : [],
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `answering` is keyed by answerKey
    [machines, answerKey],
  );
  // Every machine has answered, failed to, or is out of reach (not still connecting): only then
  // may a first host choice be written.
  const settled = machines.every(
    (machine, index) =>
      machine.status !== "connecting" &&
      (!machine.client || results[index]?.data !== undefined || results[index]?.isError === true),
  );
  const hosting: SpadeHosting = {
    machines,
    fresh: results.map((result, index) => (answering[index] ? result.data : undefined)),
    mains: records.map((main, index) => (answering[index] ? main : undefined)),
    settled,
  };
  const primary = results[machines.findIndex((machine) => machine.primary)];
  return {
    bots,
    hosts,
    /** What `useSpadeHost` decides from. */
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

/** Each machine and its Spade's agents while it answers, and whether every machine has. */
export interface SpadeHosting {
  machines: readonly Machine[];
  fresh: readonly (SpadeAgent[] | undefined)[];
  /** Each answering machine's host record and whether its main shows. */
  mains: readonly (SpadeMainState | undefined)[];
  settled: boolean;
}

/**
 * The colour pairs the bots this window has read wear, `except` left out: what Shuffle avoids
 * while it can. Read once from what the roster already holds.
 */
export function useWornPairs(except?: string): readonly string[] {
  const cache = useQueryClient();
  const [pairs] = useState(() =>
    cache
      .getQueriesData<readonly SpadeAgent[]>({ queryKey: agentsKey })
      .flatMap(([, agents]) => agents ?? [])
      .flatMap((agent) =>
        agent.id !== except && agent.avatar.kind === "character" ? [agent.avatar.face.pair] : [],
      ),
  );
  return pairs;
}
