import {
  parseSpadeRunning,
  spadeRunningOrder,
  type SpadeRunningAction,
  type SpadeRunningBot,
} from "@ace/ui-core/spade-chat";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { spadeMachineKey } from "./spade-machine.tsx";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * The Running page's data (ADR 0200 §6.3): `GET /v1/running` from every machine whose Spade
 * answers, as one list in Spade's order, read every 2 seconds while anything runs and every 10
 * otherwise, as the roster is. An action answers with every row as it reads after it, which
 * replaces that machine's rows at once.
 */

export const runningKey = ["spade", "running"] as const;

/** A row with the machine its bot runs on. */
export interface RunningRow extends SpadeRunningBot {
  machine: Machine;
}

function sure(bots: SpadeRunningBot[] | undefined): SpadeRunningBot[] {
  if (!bots) throw new Error("Spade's running list didn't make sense.");
  return bots;
}

export async function readRunning(target: SpadeTarget, signal?: AbortSignal) {
  return sure(parseSpadeRunning(await spadeHttp(target, "GET", "/v1/running", { signal })));
}

/** Stop, Pause or Resume on one bot; every row as it reads after. */
export async function actOnBot(target: SpadeTarget, bot: string, action: SpadeRunningAction) {
  const path = `/v1/agents/${segment(bot)}/${action}`;
  return sure(parseSpadeRunning(await spadeHttp(target, "POST", path, { body: {} })));
}

/** Anything of a bot that runs on by itself: the list is read faster meanwhile. */
const moving = (bot: SpadeRunningBot) =>
  bot.reads === "working" || bot.reads === "needs_you" || bot.reads === "sleeping";

export function useSpadeRunning() {
  const machines = useMachines();
  const cache = useQueryClient();
  const online = machines.filter((machine) => machine.client !== undefined);
  const results = useQueries({
    queries: online.map((machine) => ({
      queryKey: [...runningKey, spadeMachineKey(machine)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        machine.client ? readRunning(machine.client, signal) : Promise.resolve([]),
      retry: 1,
      refetchInterval: (query: { state: { data: SpadeRunningBot[] | undefined } }) =>
        query.state.data?.some(moving) ? 2_000 : 10_000,
    })),
  });
  const listed: RunningRow[] = [];
  online.forEach((machine, at) => {
    for (const bot of results[at]?.data ?? []) listed.push({ ...bot, machine });
  });
  const rows = spadeRunningOrder(listed);
  const answered = results.some((result) => result.data !== undefined);
  return {
    rows,
    loading: !answered && results.some((result) => result.isPending),
    failed: !answered && results.length > 0 && results.every((result) => result.isError),
    refetch: () => void Promise.all(results.map((result) => result.refetch())),
    /** Runs `action` on `row`'s bot; the rows its machine answers with show at once. */
    act: async (row: RunningRow, action: SpadeRunningAction) => {
      const client = row.machine.client;
      if (!client) throw new Error(`${row.machine.name} is offline.`);
      const bots = await actOnBot(client, row.id, action);
      cache.setQueryData([...runningKey, spadeMachineKey(row.machine)], bots);
      // The list and the bot's chat read its new state too.
      void cache.invalidateQueries({ queryKey: ["spade", "agents"] });
    },
  };
}
