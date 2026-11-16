import {
  parseSpadeGoalProgress,
  spadeBotWorkers,
  spadeDecisionsShown,
  spadeGoalShown,
  spadeWorkerRows,
  type SpadeDecision,
  type SpadeWorkerNode,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSpadeClient } from "./spade-machine.tsx";
import { readTask, readTree } from "./spade-work-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Every read of one bot's work: `[...workKey(bot), "task" | "tree"]`. */
export const workKey = (bot: Pick<RosterBot, "id" | "machine">) =>
  ["spade", "work", bot.machine.key, bot.id] as const;

/** The roster's word on a bot's goal: a new one (a check came back, an item closed) reads again. */
export function goalSignature(bot: RosterBot): string {
  const progress = parseSpadeGoalProgress(bot.raw);
  return progress
    ? `${progress.state}:${progress.closed}:${progress.verified}:${progress.total}`
    : "";
}

/**
 * A bot's work as its profile shows it: the goal and plan, its workers and the decisions it
 * made for the person. Read while the profile is open, faster while anything of it moves, and
 * again whenever the roster's progress for it changes. `shown` is whether there is any: the Work
 * tab is there only then.
 */
export function useSpadeWork(bot: RosterBot, decisions: readonly SpadeDecision[]) {
  const client = useSpadeClient();
  const changed = goalSignature(bot);
  const moving = bot.state !== "idle";
  const task = useQuery({
    queryKey: [...workKey(bot), "task", changed],
    queryFn: ({ signal }) => readTask(client, bot.id, signal),
    refetchInterval: moving ? 4_000 : 20_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const tree = useQuery({
    queryKey: [...workKey(bot), "tree"],
    queryFn: ({ signal }) => readTree(client, bot.id, signal),
    refetchInterval: moving ? 3_000 : 15_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const rows = useMemo(() => spadeWorkerRows(tree.data), [tree.data]);
  const decided = useMemo(() => spadeDecisionsShown(decisions), [decisions]);
  const goal = spadeGoalShown(task.data) ? task.data : undefined;
  return {
    task,
    tree,
    goal,
    rows,
    decisions: decided,
    shown: goal !== undefined || rows.length > 0 || decided.length > 0,
    /** Neither read has answered yet: whether there is work isn't known. */
    pending: task.isPending || tree.isPending,
  };
}

export type SpadeWork = ReturnType<typeof useSpadeWork>;

/**
 * The workers a delete of `bot` asks about, read fresh when asked: the bots it made, and whether
 * it started ace agents. A read that fails asks nothing; Spade refuses a delete that should have.
 */
export function useMakerWorkers(bot: RosterBot) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  return async (): Promise<{ workers: SpadeWorkerNode[]; aceAgents: boolean }> => {
    try {
      const tree = await cache.fetchQuery({
        queryKey: [...workKey(bot), "tree"],
        queryFn: ({ signal }) => readTree(client, bot.id, signal),
        staleTime: 0,
      });
      return {
        workers: spadeBotWorkers(tree),
        aceAgents: tree.children.some((child) => child.kind === "ace"),
      };
    } catch {
      return { workers: [], aceAgents: false };
    }
  };
}
