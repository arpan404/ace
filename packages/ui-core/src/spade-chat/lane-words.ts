import type { SubagentState } from "../subagents.ts";
import { spadeLaneLive, type SpadeLane, type SpadeLaneState } from "./lanes.ts";
import { spadeMoney } from "./oversight.ts";

/*
 * A bot's task lanes in words (ADR 0217 §7): the tasks pill beside the bot's ("3 tasks · 1 needs
 * you"), each row's state as ace's agent rows say it, and its one quieter line: the step and
 * count while it runs ("2 of 5 · Drafting the email to Dana"), "Queued", or its report once it
 * has ended.
 */

/** "3 tasks · 1 needs you", counting the tasks that haven't ended; "Tasks" when none run. */
export function spadeLanesPillWords(
  lanes: readonly Pick<SpadeLane, "state" | "needsYou">[],
): string {
  const live = lanes.filter(spadeLaneLive);
  if (!live.length) return "Tasks";
  const count = `${live.length} ${live.length === 1 ? "task" : "tasks"}`;
  const needs = live.filter((lane) => lane.needsYou).length;
  return needs ? `${count} · ${needs} needs you` : count;
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
