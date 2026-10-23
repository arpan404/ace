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
import { threadAttention } from "@ace/projection";
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
  /** A resume of this thread is in flight (ace's restart continuation or the person's Resume). */
  resuming = false,
): WatchedState {
  if (thread.status.state === "needs_you") return "needs_you";
  // A queue held for the person (left by a restart, an uncertain delivery or a pause) never
  // moves by itself, so a wait on it returns instead of blocking until it times out.
  if (heldFor(thread, record, resuming)) return "needs_you";
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

/** Why the thread's queue waits on the person, when it is held and not being stopped. */
export function heldFor(
  thread: Thread,
  record: DelegationRecord | undefined,
  resuming = false,
): string | undefined {
  // A queue still paused while its resume is in flight is about to move: that is work, not a
  // hold for the person.
  if (thread.status.state !== "waiting" || record?.phase === "cancelling" || resuming)
    return undefined;
  return threadAttention(thread);
}

const holdSteps: Record<string, string> = {
  restart: "held after a daemon restart until the person resumes it",
  uncertain: "held: a message may not have reached the provider; the person must review it",
  not_sent: "held: a message was not sent; the person must resend or resume it",
  model_unavailable: "held: its model is unavailable; the person must pick another",
  stopped: "held after a Stop until the person resumes it",
  manual: "paused by the person",
};

/** Short text for a model: what the person must do to release a held queue. */
export function holdStep(reason: string): string {
  return holdSteps[reason] ?? `held (${reason}) until the person resumes it`;
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
    case "browser_help":
      return request.message || "Help in the browser";
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
