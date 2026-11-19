/**
 * One make-before-break switch between two paths of the same machine (ADR 0114), as a pure
 * state machine. The I/O shell feeds it what happened and performs the actions it returns.
 *
 * - `opening`: the new path is dialing and saying hello with the same credential. The old path
 *   carries everything. Any failure here closes only the new path.
 * - `draining`: the swap happened (new sends use the new path; subscriptions catch up there
 *   from their last applied seq). The old path may still deliver replies sent before the swap.
 * - `done`: the old path is closed; commands it never answered were asked again by id.
 * - `abandoned`: the new path failed before the swap; nothing else changed.
 *
 * A failover is the same switch whose old path is already dead: it swaps at once and asks
 * every unanswered command again without draining.
 */
export type SwitchPhase = "opening" | "draining" | "done" | "abandoned";
export type SwitchEvent =
  /** The new path's hello was welcomed by the same machine. */
  | { type: "welcomed" }
  /** The new path failed: dial, pin, hello, identity or socket. */
  | { type: "new_failed" }
  /** The old path closed or missed its pong. */
  | { type: "old_failed" }
  /** The drain window ended. */
  | { type: "drain_elapsed" }
  /** Every request in flight on the old path has its reply. */
  | { type: "old_idle" };
export type SwitchAction =
  | "close_new"
  | "swap"
  | "close_old"
  /** Send again, by id, every command the old path never answered. */
  | "reask_commands"
  /** Requests the old path never answered fail as offline, as on any lost connection. */
  | "fail_old_requests"
  | "start_drain_timer";

export interface SwitchStep {
  phase: SwitchPhase;
  actions: SwitchAction[];
}

const finish: SwitchAction[] = ["close_old", "reask_commands", "fail_old_requests"];

export function switchStep(phase: SwitchPhase, event: SwitchEvent): SwitchStep {
  switch (phase) {
    case "opening":
      if (event.type === "welcomed")
        return { phase: "draining", actions: ["swap", "start_drain_timer"] };
      if (event.type === "new_failed") return { phase: "abandoned", actions: ["close_new"] };
      // The old path died first: the connection fails over on its own, so this switch stops.
      if (event.type === "old_failed") return { phase: "abandoned", actions: ["close_new"] };
      return { phase, actions: [] };
    case "draining":
      if (
        event.type === "drain_elapsed" ||
        event.type === "old_idle" ||
        event.type === "old_failed"
      )
        return { phase: "done", actions: finish };
      // The new path failing after the swap is an ordinary lost connection, not this switch's.
      return { phase, actions: [] };
    default:
      return { phase, actions: [] };
  }
}

/** A failover onto a path that is already welcomed (the warm standby): swap, then finish. */
export function failoverSteps(): SwitchAction[] {
  return ["swap", ...finish];
}
