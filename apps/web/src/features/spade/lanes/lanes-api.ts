import { parseSpadeLanes, parseSpadeTask, spadeLaneLive } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { segment, spadeHttp, SpadeRequestError, type SpadeTarget } from "../spade-requests.ts";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";

/*
 * A bot's task lanes (ADR 0217) over Spade's API: the list for its main conversation, one lane's
 * goal and plan, and Stop and Try again on a lane. A lane's own conversation is read and written
 * like any other (`useSpadeConversation`).
 */

const conversationPath = (id: string) => `/v1/conversations/${segment(id)}`;

/** Every read of a conversation's lanes: `[...lanesKey(machine, main), …]`. */
export const lanesKey = (machine: string, main: string) =>
  ["spade", "lanes", machine, main] as const;

/** Every task that hasn't ended, and the `ended` that ended last. */
export async function readLanes(
  target: SpadeTarget,
  main: string,
  ended: number,
  signal?: AbortSignal,
) {
  const path = `${conversationPath(main)}/tasks?ended=${ended}`;
  const body = await spadeHttp(target, "GET", path, { signal });
  return parseSpadeLanes(body);
}

/** A lane's goal and plan; `null` before it set one. */
export async function readLaneTask(target: SpadeTarget, lane: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", `${conversationPath(lane)}/task`, { signal });
  const task = parseSpadeTask(body);
  if (task === undefined) throw new Error("Spade's task didn't make sense.");
  return task;
}

/** Stops one task, leaving the bot's other work running. */
export async function stopLane(target: SpadeTarget, lane: string): Promise<void> {
  try {
    await spadeHttp(target, "POST", `${conversationPath(lane)}/stop`);
  } catch (error) {
    // Already ended by the time Stop arrived, which is what Stop wanted.
    if (!(error instanceof SpadeRequestError && error.status === 404)) throw error;
  }
}

/** Try again on a task that stopped early: Spade answers its failed reply again. */
export async function retryLane(target: SpadeTarget, lane: string, reply: string): Promise<void> {
  await spadeHttp(target, "POST", `${conversationPath(lane)}/retry`, { body: { reply } });
}

/**
 * The lanes of the bot whose main conversation is `main`, in Spade's order, while `enabled`
 * (the bot has tasks). Read again whenever
 * main's chat moves (`moved` changes: a lane started, reported or asked), and every few seconds
 * while one hasn't ended, for its step.
 */
export function useSpadeLanes(main: string, moved: number, enabled: boolean, ended: number) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const query = useQuery({
    queryKey: [...lanesKey(machine, main), "list", ended, moved],
    queryFn: ({ signal }) => readLanes(client, main, ended, signal),
    enabled,
    refetchInterval: (current) => (current.state.data?.some(spadeLaneLive) ? 4_000 : false),
    placeholderData: (previous) => previous,
    retry: 1,
  });
  return query.data ?? [];
}

/** A lane's goal and plan, read while its screen shows and again as its chat moves. */
export function useLaneTask(main: string, lane: string, moved: number) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  return useQuery({
    queryKey: [...lanesKey(machine, main), "task", lane, moved],
    queryFn: ({ signal }) => readLaneTask(client, lane, signal),
    placeholderData: (previous) => previous,
    retry: 1,
  });
}

/** The lane list read again now: after Stop or Try again. */
export function useLanesChanged(main: string) {
  const cache = useQueryClient();
  const machine = useSpadeMachine().key;
  return useCallback(
    () => void cache.invalidateQueries({ queryKey: lanesKey(machine, main) }),
    [cache, machine, main],
  );
}
