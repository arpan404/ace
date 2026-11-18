import type { TransferLiveStage } from "@ace/protocol";

/*
 * The source's side of a live switch-over (ADR 0190, "Switch over atomically"). Pure: each event
 * gives the next stage and what the shell does. Before `handing` nothing was committed, so the
 * target can't own the thread and the source may always run it again. From `handing` the commit
 * may have landed: only the target's own answer moves the source or returns it to running.
 */

export type CutoverEvent =
  /** The target holds the code, branch and ignored files. */
  | { type: "bulk_held" }
  /** The commit is about to be sent. */
  | { type: "committing" }
  /** The target answered that it owns the thread and its turn started. */
  | { type: "target_owns" }
  /** The target answered that it never passed its cutoff: failed, cancelled or unknown there. */
  | { type: "target_released" }
  /** Anything failed here, a lost link included; `interrupted` once the turn was stopped. */
  | { type: "failed"; interrupted: boolean };

export type CutoverEffect =
  /** Refuse new turns and hold the thread open as "Moving to <machine>". */
  | "fence"
  /** Wait for a safe point, interrupt, stop what can't move, capture the changes. */
  | "stop"
  /** Record `handing` durably, before the commit leaves. */
  | "record_handing"
  /** The thread reads moved; it runs nothing more here. */
  | "move"
  /** Lift the fence and the hold: the thread is this machine's again. */
  | "release"
  /** Tell the agent the move didn't happen, so it carries on here. */
  | "resume"
  /** The transfer fails as ADR 0101's does; the thread was never touched. */
  | "fail"
  /** Keep asking the target; nothing changes here until it answers. */
  | "keep_asking";

export interface CutoverStep {
  stage: TransferLiveStage;
  effects: CutoverEffect[];
}

export function cutoverStep(stage: TransferLiveStage, event: CutoverEvent): CutoverStep {
  const stay = (effects: CutoverEffect[] = []): CutoverStep => ({ stage, effects });
  switch (stage) {
    case "readying":
      if (event.type === "bulk_held") return { stage: "stopping", effects: ["fence", "stop"] };
      if (event.type === "failed") return stay(["fail"]);
      break;
    case "stopping":
      if (event.type === "bulk_held") return stay(["stop"]);
      if (event.type === "committing") return { stage: "handing", effects: ["record_handing"] };
      if (event.type === "failed")
        return {
          stage: "resumed",
          effects: event.interrupted ? ["release", "resume", "fail"] : ["release", "fail"],
        };
      break;
    case "handing":
      if (event.type === "committing") return stay(["record_handing"]);
      if (event.type === "target_owns") return { stage: "moved", effects: ["move"] };
      if (event.type === "target_released")
        return { stage: "resumed", effects: ["release", "resume", "fail"] };
      if (event.type === "failed") return stay(["keep_asking"]);
      break;
    case "moved":
      if (event.type === "target_owns") return stay();
      break;
    case "resumed":
      if (event.type === "failed" || event.type === "target_released") return stay();
      break;
  }
  throw new Error(`No ${event.type} while ${stage}`);
}

/** The thread may run here again: nothing committed, or the target said it never took it. */
export const runsHere = (stage: TransferLiveStage) => stage === "readying" || stage === "resumed";
