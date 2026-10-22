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

/** Work the run's turn began that is still open, besides its delegated threads. */
export interface OpenWork {
  /** Its background tasks still running (never ambient helpers). */
  tasks: number;
  /** Runs of the thread's other agents (native subagents) it started, still going. */
  agentRuns: number;
  /** Questions it asked that still wait on the person. */
  questions: number;
  /** Delegations it asked for whose threads are still being prepared. */
  reservations: number;
}

/**
 * Where the run's work stands. `root` is the thread while the run's turn is its latest; once a
 * later turn started, the thread's state is that turn's and only `work` and `children` (what
 * the run's own turn began) count. Open work always counts, whoever stopped what: a Stop or a
 * cancellation never makes a run over while its background task, subagent, preparation or a
 * delegated thread still works. With nothing open, a Stop holding the thread's queue ends the
 * run when its own cancellation made it (`cancelling`); a person's Stop, like a restart's hold,
 * waits on the person. Other holds and messages queued in the thread are others' work.
 */
export function runTreeState(facts: {
  root: RootFacts | undefined;
  work: OpenWork;
  children: CliTree;
  cancelling: boolean;
}): TreeState {
  const { work } = facts;
  const states: TreeState[] = [rootState(facts.root, facts.cancelling), childState(facts.children)];
  if (work.questions > 0) states.push("needs-human");
  if (work.tasks > 0 || work.agentRuns > 0 || work.reservations > 0) states.push("working");
  for (const state of ["uncertain", "needs-human", "working", "failed"] as const)
    if (states.includes(state)) return state;
  return "ok";
}

function rootState(root: RootFacts | undefined, cancelling: boolean): TreeState {
  if (!root) return "ok";
  const status = root.status;
  if (status.state === "unresponsive") return "uncertain";
  if (status.state === "needs_you" || root.attention === "restart") return "needs-human";
  // The thread still works: no Stop or kill makes that over.
  if (
    status.state === "working" ||
    status.state === "limited" ||
    status.state === "new" ||
    (status.state === "waiting" && status.on !== "queue")
  )
    return "working";
  // Killed work never carries on: the run is over.
  if (root.cancelled || status.state === "failed") return "failed";
  if (root.attention === "stopped") return cancelling ? "failed" : "needs-human";
  // Done, or waiting only on its queue, which holds others' messages: the run's turn is over.
  return "ok";
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
  /** Whether a stop of the run's cancellation reached its work, not only asked for. */
  stopReached: boolean;
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
  // Its work was cut short by its own stop, though the turn itself may have completed.
  if (facts.stopReached) return settleFailed("Stopped before it finished.");
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
  /** The turn's open native work: background tasks it can stop, and native subagent runs. */
  tasks: readonly string[];
  agentRuns: readonly { agentId: string; runId: string }[];
  /** Threads the run's turn delegated to that are still unsettled, and preparations of more. */
  liveChildren: readonly ThreadId[];
  reservations: readonly ThreadId[];
}

/** Work the run's turn left going after its root run ended, each part stopped on its own. */
export interface LeftoverWork {
  tasks: readonly string[];
  agentRuns: readonly { agentId: string; runId: string }[];
  children: readonly ThreadId[];
  reservations: readonly ThreadId[];
}

export type StopPlan =
  /** Take the run's message out of the queue. */
  | { kind: "remove" }
  /** Stop the run's own root run `runId`, with everything under it. */
  | { kind: "interrupt"; runId: string }
  /** The turn's root run ended: stop what it left going, part by part. */
  | ({ kind: "stop-work" } & LeftoverWork)
  /** The run's message isn't taken by a run yet, or someone else's turn runs: stop it later. */
  | { kind: "wait" }
  /** Nothing of the run is left to stop. */
  | { kind: "none" };

/**
 * What stopping a run means now, never touching anyone else's work. A message still queued is
 * taken out. A turn is stopped only by the id of a root run of the run's own turn, a guard the
 * engine checks again when it delivers the stop, so it can never land on a turn someone started
 * meanwhile. A message on its way but not yet taken by a run is left until a run takes it. Once
 * the turn's root run ended, only what that turn left going is stopped: its background tasks
 * and native subagent runs by their own ids, its delegated threads and their preparations.
 */
export function stopPlan(facts: StopFacts): StopPlan {
  const fate = facts.fate;
  switch (fate.state) {
    case "waiting":
    case "uncertain":
      return { kind: "remove" };
    case "replaced":
    case "sending":
      return { kind: "wait" };
    case "removed":
    case "failed":
      return { kind: "none" };
    case "unknown":
    case "delivered": {
      const bound = (fate.state === "delivered" ? fate.runId : undefined) ?? facts.boundRun;
      if (bound === undefined)
        return fate.state === "unknown" ? { kind: "none" } : { kind: "wait" };
      if (facts.rootActive?.ours) return { kind: "interrupt", runId: facts.rootActive.runId };
      const left: LeftoverWork = {
        tasks: facts.tasks,
        agentRuns: facts.agentRuns,
        children: facts.liveChildren,
        reservations: facts.reservations,
      };
      return Object.values(left).some((part) => part.length > 0)
        ? { kind: "stop-work", ...left }
        : { kind: "none" };
    }
  }
}
