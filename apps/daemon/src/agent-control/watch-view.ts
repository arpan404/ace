import type {
  AgentStatus,
  DelegationRecord,
  InteractionRequest,
  Thread,
  WaitMode,
  WaitStatus,
  WatchedState,
  WatchedThread,
} from "@ace/protocol";
import { agentTaskView } from "./task-view.ts";

/*
 * Pure decisions for bounded waits and tree snapshots: what state a watched thread is in,
 * whether a wait is satisfied, and short text for a model to read.
 */

export const settledStates: ReadonlySet<WatchedState> = new Set(["done", "failed", "cancelled"]);

/**
 * A watched thread is settled only when its whole tree is: a delegated child with live
 * descendants keeps working, and any request for the person wins over everything else.
 */
export function watchedState(
  thread: Thread,
  record: DelegationRecord | undefined,
  descendantsPending: boolean,
  rootIdle: boolean,
): WatchedState {
  if (thread.status.state === "needs_you") return "needs_you";
  if (record) {
    const view = agentTaskView(thread, record, descendantsPending, rootIdle);
    if (view.state === "waiting_on_human") return "needs_you";
    if (descendantsPending) return "working";
    return view.state === "result_available"
      ? "done"
      : view.state === "failed" || view.state === "cancelled"
        ? view.state
        : "working";
  }
  if (thread.status.state === "failed") return "failed";
  if (thread.status.state === "done")
    return thread.queue?.lastFailure?.code === "cancelled" ? "cancelled" : "done";
  return "working";
}

/** Undefined while the wait should keep blocking. A request for the person returns at once. */
export function waitOutcome(
  states: readonly WatchedState[],
  mode: WaitMode,
): WaitStatus | undefined {
  if (states.includes("needs_you")) return "needs_you";
  const settled = states.filter((state) => settledStates.has(state)).length;
  return (mode === "any" ? settled > 0 : settled === states.length) ? "ready" : undefined;
}

/** What the thread's root agent is doing, in a few words. */
export function agentStep(status: AgentStatus | undefined): string | undefined {
  switch (status?.state) {
    case "working":
      return status.detail ?? status.activity;
    case "blocked":
      return `waiting on ${status.on.replaceAll("_", " ")}`;
    case "starting":
    case "unresponsive":
      return status.state;
    default:
      return undefined;
  }
}

/** The person-facing question of a request, without its options or payloads. */
export function requestPrompt(request: InteractionRequest): string {
  switch (request.kind) {
    case "approval":
      return request.title;
    case "question":
      return request.questions.map((question) => question.text).join(" / ");
    case "plan_review":
      return request.title ?? "Review the plan";
    case "elicitation":
      return request.title ?? request.message;
  }
}

/** One line, at most `max` UTF-16 units, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  let units = 0;
  for (const point of line) {
    if (units + point.length > max - 1) break;
    units += point.length;
  }
  return `${line.slice(0, units)}…`;
}

/** The last non-empty line of an output, clipped. */
export function lastLine(text: string, max: number): string | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (line) return clip(line, max);
  }
  return undefined;
}

export function elapsedSeconds(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 1000));
}

/** Result excerpt characters one wait answer carries across all of its threads. */
const sharedResultChars = 128 * 1024;
const fullResultChars = 4096;
/**
 * A wait on many children splits one excerpt budget between them, so the answer stays inside
 * the tool result budget however many threads it watches. A shortened excerpt is marked
 * truncated; the full result stays readable with agents_status or thread_read.
 */
export function shareResults(threads: readonly WatchedThread[]): WatchedThread[] {
  const share = Math.min(
    fullResultChars,
    Math.floor(sharedResultChars / Math.max(1, threads.length)),
  );
  return threads.map((thread) => {
    if (thread.result === undefined || thread.result.length <= share) return thread;
    let units = 0;
    for (const point of thread.result) {
      if (units + point.length > share) break;
      units += point.length;
    }
    return { ...thread, result: thread.result.slice(0, units), truncated: true };
  });
}
