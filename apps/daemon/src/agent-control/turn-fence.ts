import type { RunAt } from "../engine/turn-origin.ts";

/*
 * The delegation fence a Stop sets on a thread's turn (ADR 0191): which delegation calls it
 * refuses. Pure. Runs are ordered by their `seq` in the thread, never by the clock.
 */

/** What a Stop recorded about the thread, kept until the thread's next Stop replaces it. */
export interface TurnFence {
  /** The run the Stop ended ("" when none ran); absent once a newer turn lifted the fence. */
  run?: string | undefined;
  /** The thread's last run `seq` when the Stop came: every run up to it is the stopped work's. */
  stopSeq: number;
  /** The `seq` of the turn that lifted the fence; runs before it stay the stopped work's. */
  liftedSeq?: number | undefined;
}

export interface TurnFenceCall {
  /** The thread's root turn: its running run, else its last. */
  root?: RunAt | undefined;
  /** The run the calling agent is in itself. */
  origin?: RunAt | undefined;
  /** The call is one a Stop caught on its way (any Stop of the thread), not yet resolved. */
  stopped: boolean;
}

export type TurnFenceAnswer =
  | { kind: "admit" }
  | { kind: "refuse" }
  /** Admitted, and the first call of the new turn: the fence lifts at `seq`. */
  | { kind: "lift"; seq: number };

/**
 * A call the stopped turn had on its way is always refused. While fenced, only a call made from
 * a root turn that began after the Stop lifts it: the caller's own run is that turn or began
 * after it. Once lifted, a call from a run that began before the lifting turn (a provider
 * subagent still running from the stopped work, say) is still refused.
 */
export function turnFence(fence: TurnFence, call: TurnFenceCall): TurnFenceAnswer {
  const { root, origin } = call;
  if (call.stopped || !origin) return { kind: "refuse" };
  if (fence.liftedSeq !== undefined)
    return origin.seq >= fence.liftedSeq ? { kind: "admit" } : { kind: "refuse" };
  if (!root || root.id === fence.run || root.seq <= fence.stopSeq) return { kind: "refuse" };
  return origin.seq >= root.seq ? { kind: "lift", seq: root.seq } : { kind: "refuse" };
}
