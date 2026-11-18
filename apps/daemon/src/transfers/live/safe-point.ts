/*
 * When a working thread may be stopped to move it (ADR 0190, "Stop at a safe point"). Pure.
 */

/** What the engine says about the thread's turn right now. */
export interface TurnFacts {
  /** An agent of the thread is in a turn. */
  turnRunning: boolean;
  /** Tool calls still running. */
  toolsRunning: number;
  /** Replies, thoughts or compactions still streaming. */
  streaming: number;
}

export type SafePoint =
  /** The turn ended on its own: nothing to interrupt. */
  | { kind: "boundary" }
  /** No tool call running and nothing streaming: interrupt now. */
  | { kind: "between_tools" }
  /** Waited long enough: interrupt anyway, so a long tool call can't hold the move forever. */
  | { kind: "deadline" }
  | { kind: "wait" };

/** The longest the move waits for a turn to reach a safe point by itself. */
export const safePointDeadlineMs = 90_000;

export function safePoint(facts: TurnFacts, waitedMs: number): SafePoint {
  if (!facts.turnRunning) return { kind: "boundary" };
  if (facts.toolsRunning === 0 && facts.streaming === 0) return { kind: "between_tools" };
  if (waitedMs >= safePointDeadlineMs) return { kind: "deadline" };
  return { kind: "wait" };
}

/** Whether the turn must be interrupted at this safe point. */
export const interrupts = (point: SafePoint) =>
  point.kind === "between_tools" || point.kind === "deadline";
