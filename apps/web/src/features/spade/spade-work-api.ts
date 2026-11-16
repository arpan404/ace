import { parseSpadeTask, parseSpadeTree } from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * A bot's work (ADR 0159, 0161): its goal and plan, the person's changes to the goal, its tree of
 * workers, and Stop on one of them. Each answer parsed with `@ace/ui-core/spade-chat`; one that
 * doesn't parse throws, in words.
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

const agentPath = (agent: string) => `/v1/agents/${segment(agent)}`;

/** The task, `null` when the bot never had a goal. */
export async function readTask(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", `${agentPath(agent)}/task`, { signal });
  return sure(parseSpadeTask(body), "task");
}

export interface SpadeGoalChange {
  title: string;
  criteria: readonly string[];
  text?: string;
}

/** Sets the goal, or changes the open one; only the person can. */
export async function setGoal(target: SpadeTarget, agent: string, change: SpadeGoalChange) {
  const body = await spadeHttp(target, "PUT", `${agentPath(agent)}/task/goal`, { body: change });
  return sure(parseSpadeTask(body) ?? undefined, "task");
}

/** Ends the open goal without it being done. */
export async function endGoal(target: SpadeTarget, agent: string): Promise<void> {
  await spadeHttp(target, "DELETE", `${agentPath(agent)}/task/goal`);
}

export async function readTree(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", `${agentPath(agent)}/tree`, { signal });
  return sure(parseSpadeTree(body), "workers");
}

/** Stops a worker bot and everything under it, as Stop in its own chat does. */
export async function stopConversation(target: SpadeTarget, conversation: string): Promise<void> {
  await spadeHttp(target, "POST", `/v1/conversations/${segment(conversation)}/stop`);
}

/** Deletes a bot that made workers; they become the person's own bots, stopped or still going. */
export async function deleteMaker(
  target: SpadeTarget,
  agent: string,
  workers: "stop" | "keep",
): Promise<void> {
  await spadeHttp(target, "DELETE", `${agentPath(agent)}?workers=${workers}`);
}
