import type { BackgroundTask } from "@ace/protocol";

/*
 * Background commands a turn started back to back, as one row the way tool calls group: "Ran 3
 * background tasks", opened for the ended ones (each still opens its output). A running one
 * always keeps its own line, where its Stop lives. Nothing that ended, however quickly, gets a
 * row of its own outside the group. Pure.
 */

type TaskFacts = Pick<BackgroundTask, "status">;

export interface BackgroundGroup {
  /** "Ran 3 background tasks", or "3 background tasks · 1 running" while some still run. */
  label: string;
  /** Indexes of the tasks still running: each keeps its own line. */
  running: number[];
  /** Indexes of the ended tasks, listed when the group is opened. */
  listed: number[];
}

export function backgroundGroup(tasks: readonly (TaskFacts | undefined)[]): BackgroundGroup {
  const running: number[] = [];
  const listed: number[] = [];
  for (const [index, task] of tasks.entries()) {
    if (!task) continue;
    if (task.status === "running") running.push(index);
    else listed.push(index);
  }
  const total = tasks.length;
  const noun = total === 1 ? "background task" : "background tasks";
  const label = running.length
    ? `${total} ${noun} · ${running.length} running`
    : `Ran ${total} ${noun}`;
  return { label, running, listed };
}
