import type { CliTree, CommandId, Run, ThreadId } from "@ace/protocol";
import type { InputFate } from "./engine/input-fate.ts";
import { treeOutcome } from "./work-outcome.ts";

/**
 * Pure rules for one automation run in its thread: when it is over and how it went, and what
 * stopping it means right now. The run is the turn its message started: the engine run that
 * took the message, every root run after it until the next ask, and the work that turn began.
 */

/** Where the work a run began stands, whole tree included. */
export type TreeState = "working" | "needs-human" | "uncertain" | "ok" | "failed";

/** The run's thread itself, read while no later turn has started in it (`readTreeMembers`). */
export type RootFacts = Pick<CliTree[number], "status" | "attention" | "cancelled">;

/**
 * Where the run's work stands. `root` is the thread while the run's turn is its latest; once a
 * later turn started, the thread's state is that turn's, so `windowWork` (runs, background work
 * and questions the run's turn began) stands in for it. `children` are the threads the turn
 * delegated to, with theirs. A Stop holds the thread's queue for the person: when the run's
 * own cancellation made it (`cancelling`), the run is over; a person's Stop, like a restart's
 * hold, waits on the person to carry the turn on or let it go. Other holds and messages queued
 * in the thread are others' work, not the run's.
 */
export function runTreeState(facts: {
  root: RootFacts | undefined;
  windowWork: "none" | "working" | "needs-human";
  children: CliTree;
  cancelling: boolean;
}): TreeState {
  const states: TreeState[] = [rootState(facts.root, facts.cancelling), childState(facts.children)];
  if (facts.windowWork === "working") states.push("working");
  if (facts.windowWork === "needs-human") states.push("needs-human");
  for (const state of ["uncertain", "needs-human", "working", "failed"] as const)
    if (states.includes(state)) return state;
  return "ok";
}

function rootState(root: RootFacts | undefined, cancelling: boolean): TreeState {
  if (!root) return "ok";
  if (root.status.state === "unresponsive") return "uncertain";
  if (root.status.state === "needs_you" || root.attention === "restart") return "needs-human";
  // Killed work never carries on: the run is over.
  if (root.cancelled || root.status.state === "failed") return "failed";
  if (root.attention === "stopped") return cancelling ? "failed" : "needs-human";
  // A thread waiting only on its queue holds others' messages; the run's turn is over.
  if (root.status.state === "waiting" && root.status.on === "queue") return "ok";
  return root.status.state === "done" ? "ok" : "working";
}

function childState(children: CliTree): TreeState {
  if (!children.length) return "ok";
  const outcome = treeOutcome(children);
  if (outcome === "needs-human" || outcome === "uncertain") return outcome;
  return outcome === undefined ? "working" : outcome;
}

/** The run's turn: whether any of its root runs still runs, and how its last one ended. */
export interface TurnFacts {
  active: boolean;
  last: Run["state"] | undefined;
}

export interface RunFacts {
  threadDeleted: boolean;
  fate: InputFate;
  /** The engine run the record saw take the message, kept after the engine forgets it. */
  boundRun: string | undefined;
  cancel: "requested" | "sent" | undefined;
  /** Facts of the run's turn, once an engine run took the message. */
  turn: TurnFacts | undefined;
  tree: TreeState | undefined;
}

export type RunDecision =
  | { kind: "wait" }
  /** The person sent the message again: the run carries on as that command. */
  | { kind: "follow"; commandId: CommandId }
  /** The run is over. Without `result`, its answer is the turn's last prose, else `fallback`. */
  | {
      kind: "settle";
      status: "succeeded" | "failed";
      result?: string;
      fallback?: string;
    };

export function decideRun(facts: RunFacts): RunDecision {
  const stopped = facts.cancel !== undefined;
  if (facts.threadDeleted) return settleFailed("Its thread was deleted before the run finished.");
  const fate = facts.fate;
  switch (fate.state) {
    case "replaced":
      return { kind: "follow", commandId: fate.by };
    case "removed":
      return settleFailed(
        stopped ? "Stopped before it started." : "Its message was taken out of the queue.",
      );
    case "failed":
      return settleFailed(
        stopped ? "Stopped before it started." : `Its message was not sent: ${fate.error}`,
      );
    case "waiting":
    case "sending":
    case "uncertain":
      return { kind: "wait" };
    case "unknown":
      if (facts.boundRun === undefined)
        return settleFailed(stopped ? "Stopped before it started." : "Its message is gone.");
      return settled(facts, stopped);
    case "delivered":
      if (fate.runId === undefined && facts.boundRun === undefined) return { kind: "wait" };
      return settled(facts, stopped);
  }
}

/** A delivered run is over once its turn's root runs ended and nothing it began still works. */
function settled(facts: RunFacts, stopped: boolean): RunDecision {
  const { turn, tree } = facts;
  if (!turn || turn.active || tree === undefined) return { kind: "wait" };
  if (tree === "working" || tree === "needs-human" || tree === "uncertain") return { kind: "wait" };
  if (tree === "ok" && turn.last === "completed")
    return { kind: "settle", status: "succeeded", fallback: "Finished without a written answer." };
  if (stopped) return settleFailed("Stopped before it finished.");
  return { kind: "settle", status: "failed", fallback: "Stopped before it finished." };
}

function settleFailed(result: string): RunDecision {
  return { kind: "settle", status: "failed", result };
}

export interface StopFacts {
  fate: InputFate;
  boundRun: string | undefined;
  /** The thread's running root run, and whether it is part of the run's turn. */
  rootActive: { runId: string; ours: boolean } | undefined;
  /** Threads the run's turn delegated to that are still unsettled. */
  liveChildren: readonly ThreadId[];
}

export type StopPlan =
  /** Take the run's message out of the queue. */
  | { kind: "remove" }
  /** Stop the thread's turn: only `runId`, when it is the run's own. */
  | { kind: "interrupt"; runId?: string }
  /** The turn ended; stop the threads it delegated to. */
  | { kind: "cancel-children"; children: readonly ThreadId[] }
  /** Someone else's turn runs first; stop the run once it starts. */
  | { kind: "wait" }
  /** Nothing of the run is left to stop. */
  | { kind: "none" };

/**
 * What stopping a run means now, never touching anyone else's work: a message still queued is
 * taken out; a turn is stopped only while it is the run's own (its engine run, or one of its
 * turn's later root runs); a message on its way with no turn running is stopped before any can
 * start; after the turn, only the threads it delegated to are left.
 */
export function stopPlan(facts: StopFacts): StopPlan {
  const fate = facts.fate;
  switch (fate.state) {
    case "waiting":
    case "uncertain":
      return { kind: "remove" };
    case "replaced":
      return { kind: "wait" };
    case "removed":
    case "failed":
      return { kind: "none" };
    case "sending":
      return facts.rootActive ? { kind: "wait" } : { kind: "interrupt" };
    case "unknown":
    case "delivered": {
      const bound = (fate.state === "delivered" ? fate.runId : undefined) ?? facts.boundRun;
      if (bound === undefined)
        return fate.state === "unknown"
          ? { kind: "none" }
          : facts.rootActive
            ? { kind: "wait" }
            : { kind: "interrupt" };
      if (facts.rootActive?.ours) return { kind: "interrupt", runId: facts.rootActive.runId };
      if (facts.liveChildren.length)
        return { kind: "cancel-children", children: facts.liveChildren };
      return { kind: "none" };
    }
  }
}
