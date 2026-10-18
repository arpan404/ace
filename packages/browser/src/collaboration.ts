import type { BrowserCommand } from "@ace/protocol";

/*
 * People and agents share every tab (ADR 0067, "Collaboration"). Nobody takes or hands back
 * control: the person's input always lands at once, and an agent's input politely waits while
 * the person is busy in the same tab. These are the pure rules; the tab runtime applies them.
 */

export interface CollaborationTiming {
  /** The person counts as active in a tab for this long after their last input there. */
  quietMs: number;
  /** The longest an agent's input waits for the person to pause before it gives up. */
  maxWaitMs: number;
  /** A tab stays marked as in use by an agent for this long after its last command. */
  inUseMs: number;
  /**
   * The person counts as working in a tab for this long after their last input there: an
   * agent's typing then keeps the field's text and gives back the person's focus and caret.
   */
  presentMs: number;
  /** After the person picks a tab, an agent's new tab stops taking the view for this long. */
  followAfterMs: number;
}

export const collaborationTiming: CollaborationTiming = {
  quietMs: 1_500,
  maxWaitMs: 10_000,
  inUseMs: 8_000,
  followAfterMs: 30_000,
  presentMs: 30_000,
};

/**
 * Agent commands that act on the page the way a person would: they wait while the person is
 * busy in the tab. Reads (snapshot, screenshot, evaluate, logs, find, waits) never wait.
 */
const personalActions = new Set<BrowserCommand["action"]>([
  "click",
  "type",
  "press",
  "scroll",
  "drag",
  "hover",
  "navigate",
  "fill_form",
  "select",
  "check",
  "uncheck",
  "focus",
  "upload",
]);

export function waitsForPerson(command: BrowserCommand): boolean {
  if (command.action === "history") return command.direction !== "stop";
  if (command.action === "measure_interaction") return command.interaction !== undefined;
  return personalActions.has(command.action);
}

/**
 * How much longer an agent's input waits for the person: 0 runs it now, `"give_up"` ends the
 * wait (the person stayed busy past `maxWaitMs`).
 */
export function agentInputDelay(
  now: number,
  humanAt: number,
  waitingSince: number,
  timing: CollaborationTiming,
): number | "give_up" {
  const quietIn = humanAt + timing.quietMs - now;
  if (quietIn <= 0) return 0;
  const left = waitingSince + timing.maxWaitMs - now;
  if (left <= 0) return "give_up";
  return Math.min(quietIn, left);
}
