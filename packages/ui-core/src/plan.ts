import type { ThreadReader } from "@ace/client";
import type { TodoEntry, ToolDetail } from "@ace/protocol";

/*
 * The plan pinned above the composer (UX audit CMP-6): the latest todo list the main agent
 * wrote in its latest turn, as "Plan 3/7", until every item is settled and the turn is over.
 */

export type PlanReader = Pick<ThreadReader, "order" | "item" | "thread">;

/** The todo or plan step a chip follows, and the turn (run) it belongs to. */
export interface PlanStep {
  itemId: string;
  runId: string | undefined;
}

/** The todo list a todo or plan step carries, if any. */
export function planTodos(detail: ToolDetail | undefined): readonly TodoEntry[] {
  if (detail?.kind === "todo") return detail.todos;
  if (detail?.kind === "plan") return detail.todos ?? [];
  return [];
}

/**
 * The main agent's latest todo or plan step within its latest turn, or undefined when that turn
 * has none. The step counts before its list arrives (a provider may stream it in), so the chip
 * can follow it from the start. Walks back from the end only as far as that turn's start, so a
 * long thread costs no more than its last turn. Subagents' lists never pin.
 */
export function latestPlanStep(reader: PlanReader): PlanStep | undefined {
  const root = reader.thread?.rootAgentId;
  let turn: string | undefined;
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const item = reader.item(reader.order[index] ?? "");
    if (!item || (root !== undefined && item.agentId !== root)) continue;
    if (item.runId !== undefined) {
      turn ??= item.runId;
      if (item.runId !== turn) return undefined;
    }
    if (item.type === "tool_call" && (item.call.kind === "todo" || item.call.kind === "plan"))
      return { itemId: item.id, runId: item.runId };
  }
  return undefined;
}

export function samePlanStep(a: PlanStep | undefined, b: PlanStep | undefined): boolean {
  return a?.itemId === b?.itemId && a?.runId === b?.runId;
}

export interface PlanProgress {
  todos: readonly TodoEntry[];
  /** Items completed. */
  done: number;
  total: number;
  /** Every item is completed or cancelled: nothing is left to do. */
  settled: boolean;
}

export function planProgress(todos: readonly TodoEntry[]): PlanProgress {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return {
    todos,
    done,
    total: todos.length,
    settled: todos.every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  };
}

/** The chip shows while there is a list, until it is all settled and its turn has ended. */
export function planShown(progress: PlanProgress, turnEnded: boolean): boolean {
  return progress.total > 0 && !(progress.settled && turnEnded);
}

/** "Plan 3/7". */
export function planLabel(progress: PlanProgress): string {
  return `Plan ${progress.done}/${progress.total}`;
}

/** The chip's tooltip: the item in progress ("Now: Fix the cursor"), else how far it is. */
export function planTip(progress: PlanProgress): string {
  const now = progress.todos.find((todo) => todo.status === "in_progress");
  return now ? `Now: ${now.content}` : `${progress.done} of ${progress.total} done`;
}

/** Each item's status as a glyph (☐ ▸ ✓ ✕) and in words for assistive tech. */
export const todoMarks: Record<TodoEntry["status"], { glyph: string; words: string }> = {
  pending: { glyph: "☐", words: "To do" },
  in_progress: { glyph: "▸", words: "In progress" },
  completed: { glyph: "✓", words: "Done" },
  cancelled: { glyph: "✕", words: "Cancelled" },
};
