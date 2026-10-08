import type { ThreadReader } from "@ace/client";
import type { Item, TodoEntry, ToolDetail } from "@ace/protocol";

/*
 * The agents' to-do lists in the composer's tab: each agent's latest todo or plan step within
 * the current turn, collapsed to the step it is on ("3 of 6") or raised to the whole list, until
 * every item is settled and the turn is over.
 */

export type PlanReader = Pick<ThreadReader, "order" | "item" | "thread">;

/** The todo or plan step a tab follows, the turn (run) it belongs to and whose list it is. */
export interface PlanStep {
  itemId: string;
  runId: string | undefined;
  agentId: string;
}

/** The todo list a todo or plan step carries, if any. */
export function planTodos(detail: ToolDetail | undefined): readonly TodoEntry[] {
  if (detail?.kind === "todo") return detail.todos;
  if (detail?.kind === "plan") return detail.todos ?? [];
  return [];
}

const isPlanStep = (item: Item | undefined) =>
  item?.type === "tool_call" && (item.call.kind === "todo" || item.call.kind === "plan");

/**
 * Every agent's latest todo or plan step within its latest turn, the main agent's first, then
 * the others from the most recently updated. A step counts before its list arrives (a provider
 * may stream it in), so the tab can follow it from the start. Walks back from the end only as
 * far as the main agent's latest turn, so a long thread costs no more than its last turn; a
 * subagent's list from an earlier turn of its own never shows.
 */
export function latestPlanSteps(reader: PlanReader): readonly PlanStep[] {
  const root = reader.thread?.rootAgentId;
  const newestRun = new Map<string, string>();
  const found = new Map<string, PlanStep>();
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const item = reader.item(reader.order[index] ?? "");
    const agent = item?.agentId;
    if (!item || agent === undefined) continue;
    if (item.runId !== undefined) {
      const newest = newestRun.get(agent);
      if (newest === undefined) newestRun.set(agent, item.runId);
      else if (newest !== item.runId) {
        // An earlier turn: the main agent's ends the walk; another agent's is passed over.
        if (agent === root || root === undefined) break;
        continue;
      }
    }
    if (!found.has(agent) && isPlanStep(item))
      found.set(agent, { itemId: item.id, runId: item.runId, agentId: agent });
  }
  const steps = [...found.values()];
  const main = steps.findIndex((step) => step.agentId === root);
  if (main > 0) steps.unshift(...steps.splice(main, 1));
  return steps;
}

export function samePlanSteps(a: readonly PlanStep[], b: readonly PlanStep[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (step, index) =>
        step.itemId === b[index]?.itemId &&
        step.runId === b[index]?.runId &&
        step.agentId === b[index]?.agentId,
    )
  );
}

export interface PlanProgress {
  todos: readonly TodoEntry[];
  /** Items completed. */
  done: number;
  total: number;
  /** The item in progress, if any. */
  current: TodoEntry | undefined;
  /** Every item is completed or cancelled: nothing is left to do. */
  settled: boolean;
}

export function planProgress(todos: readonly TodoEntry[]): PlanProgress {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return {
    todos,
    done,
    total: todos.length,
    current: todos.find((todo) => todo.status === "in_progress"),
    settled: todos.every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  };
}

/** The tab shows a list while there is one, until it is all settled and its turn has ended. */
export function planShown(progress: PlanProgress, turnEnded: boolean): boolean {
  return progress.total > 0 && !(progress.settled && turnEnded);
}

/** "3 of 6": items done out of all of them. */
export function planCount(progress: Pick<PlanProgress, "done" | "total">): string {
  return `${progress.done} of ${progress.total}`;
}

/**
 * Since when the agent has been on its current item: the first of its updates in this turn,
 * counting back from `step` without a break, that already had that item in progress. Undefined
 * when nothing is in progress. A provider that rewrites one plan item in place reports the
 * item's own start.
 */
export function currentStepSince(reader: PlanReader, step: PlanStep): number | undefined {
  const now = planProgress(planTodos(toolDetail(reader.item(step.itemId)))).current;
  if (!now) return undefined;
  let since: number | undefined;
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const item = reader.item(reader.order[index] ?? "");
    if (!item || item.agentId !== step.agentId) continue;
    if (item.runId !== undefined && item.runId !== step.runId) break;
    if (!isPlanStep(item)) continue;
    if (since === undefined && item.id !== step.itemId) continue;
    const current = planProgress(planTodos(toolDetail(item))).current;
    if (current?.content !== now.content) break;
    since = item.createdAt;
  }
  return since;
}

const toolDetail = (item: Item | undefined) =>
  item?.type === "tool_call" ? item.call.detail : undefined;
