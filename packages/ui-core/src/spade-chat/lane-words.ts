import type { SubagentState } from "../subagents.ts";
import { spadeLaneLive, type SpadeLane, type SpadeLaneState } from "./lanes.ts";
import { spadeMoney } from "./oversight.ts";

/*
 * A bot's task lanes in words (ADR 0217 §7): the tasks pill beside the bot's ("3 tasks · 1 needs
 * you"), each row's state as ace's agent rows say it, and its one quieter line: the step and
 * count while it runs ("2 of 5 · Drafting the email to Dana"), "Queued", or its report once it
 * has ended.
 */

/** "3 tasks · 1 needs you" ("2 need you"), counting the tasks that haven't ended; "Tasks" when none run. */
export function spadeLanesPillWords(
  lanes: readonly Pick<SpadeLane, "state" | "needsYou">[],
): string {
  const live = lanes.filter(spadeLaneLive);
  if (!live.length) return "Tasks";
  const count = `${live.length} ${live.length === 1 ? "task" : "tasks"}`;
  const needs = live.filter((lane) => lane.needsYou).length;
  return needs ? `${count} · ${needs} ${needs === 1 ? "needs" : "need"} you` : count;
}

/** Whether any task waits on the person: the pill then leads with that. */
export const spadeLanesNeedYou = (lanes: readonly Pick<SpadeLane, "state" | "needsYou">[]) =>
  lanes.some((lane) => spadeLaneLive(lane) && lane.needsYou);

/** A task's state as ace's agent rows word and tone it. */
export function spadeLaneRowState(lane: Pick<SpadeLane, "state" | "needsYou">): SubagentState {
  if (lane.needsYou) return "human";
  const states: Record<SpadeLaneState, SubagentState> = {
    needs_you: "human",
    working: "working",
    queued: "queued",
    done: "done",
    finished: "done",
    failed: "failed",
    stopped: "cancelled",
  };
  return states[lane.state];
}

/** "2 of 5 · Drafting the email to Dana" while it runs with a plan. */
export function spadeLaneStep(
  lane: Pick<SpadeLane, "state" | "progress" | "planStep">,
): string | undefined {
  if (lane.state === "queued") return "Queued";
  if (!spadeLaneLive(lane)) return undefined;
  const count =
    lane.progress && lane.progress.total > 0
      ? `${lane.progress.done} of ${lane.progress.total}`
      : undefined;
  const said = [count, lane.planStep].filter(Boolean).join(" · ");
  return said || undefined;
}

/** A row's quieter line: its step while it runs, its report (or how it ended) after. */
export function spadeLaneDetail(lane: SpadeLane): string | undefined {
  if (spadeLaneLive(lane)) return spadeLaneStep(lane);
  if (lane.state === "failed")
    return lane.report ? `Stopped early: ${lane.report}` : "Stopped early";
  if (lane.state === "stopped") return lane.report || "Stopped";
  return lane.report;
}

/** What a task's steps cost, shown quietly and never capped (ADR 0166); nothing before any. */
export const spadeLaneCost = (lane: Pick<SpadeLane, "costMicros">) =>
  lane.costMicros > 0 ? spadeMoney(lane.costMicros) : undefined;

/** How many of a bot's tasks haven't ended, as the roster counts them (`tasks`). */
export function spadeAgentTasks(raw: Record<string, unknown>): number {
  const tasks = raw.tasks;
  return typeof tasks === "number" && Number.isFinite(tasks) && tasks > 0 ? tasks : 0;
}

/**
 * How main's chat stands on its tasks, as a number that changes whenever a task's line arrives or
 * a request waits: the task list is read again when it does. Zero when the chat has none.
 */
export function spadeLanesMoved(
  entries: readonly { kind: string; quiet?: { kind: string } }[],
  approvals: number,
): number {
  let lines = 0;
  for (const entry of entries) if (entry.kind === "quiet" && entry.quiet?.kind === "lane") lines++;
  return lines === 0 ? 0 : lines * 1000 + approvals;
}

/** How many ended tasks the list asks for at first, and how many more each time (ADR 0217). */
export const spadeEndedTasksPage = 20;

/**
 * Whether older ended tasks may be left out: Spade lists every task that hasn't ended and the
 * `asked` that ended last, so a full page of ended ones may have more behind it.
 */
export function spadeLanesHaveOlder(lanes: readonly Pick<SpadeLane, "state">[], asked: number) {
  return lanes.filter((lane) => !spadeLaneLive(lane)).length >= asked;
}

/**
 * Main's id for its copy of a task's request (ADR 0217 §4), found from the task's side: the
 * request main holds for task `task` whose call in the task is `call`. Ids are opaque, never built
 * from their parts; undefined when main holds no such request open.
 */
export function spadeMainCopyOf(
  requests: readonly { callId: string; lane?: { task: string; call?: string } }[],
  task: string,
  call: string,
): string | undefined {
  return requests.find((request) => request.lane?.task === task && request.lane.call === call)
    ?.callId;
}
