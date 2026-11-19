import { parseSpadeGoalProgress, spadeGoalMissing } from "@ace/ui-core/spade-chat";
import { useQueries } from "@tanstack/react-query";
import { useMachines } from "@/lib/machines.ts";
import { spadeMachineKey } from "./spade-machine.tsx";
import { readTask } from "./spade-work-api.ts";
import { goalSignature, workKey } from "./use-spade-work.ts";
import type { SpadeGoalMissing } from "./spade-list-rows.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * What the check found missing for each bot it sent back (`not_yet`), for its row's "Not yet: …",
 * by `machine/id`. Read once per verdict, only for those bots; the same read Work uses.
 */
export function useGoalMissing(bots: readonly RosterBot[]): SpadeGoalMissing {
  const machines = useMachines();
  const sentBack = bots.filter(
    (bot) => !bot.away && parseSpadeGoalProgress(bot.raw)?.state === "not_yet",
  );
  const results = useQueries({
    queries: sentBack.map((bot) => {
      const client = machines.find(
        (machine) => spadeMachineKey(machine) === bot.machine.key,
      )?.client;
      return {
        queryKey: [...workKey(bot), "task", goalSignature(bot)],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          client ? readTask(client, bot.id, signal) : Promise.reject(new Error("offline")),
        enabled: client !== undefined,
        staleTime: 60_000,
        retry: 1,
      };
    }),
  });
  const missing = new Map<string, string>();
  sentBack.forEach((bot, index) => {
    const task = results[index]?.data;
    const words = task ? spadeGoalMissing(task) : undefined;
    if (words) missing.set(`${bot.machine.key}/${bot.id}`, words);
  });
  return missing;
}
