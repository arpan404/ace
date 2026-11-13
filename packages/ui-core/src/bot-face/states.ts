/*
 * What a face does: a pose per state, and how it gets there. Only working and thinking loop;
 * every other state moves once and holds its last pose, which is also what reduced motion shows.
 */

export type BotFaceState =
  | "idle"
  | "acknowledge"
  | "thinking"
  | "working"
  | "needs-you"
  | "blocked"
  | "done";

export interface BotFaceMotion {
  /** `loop`: repeats while the state lasts; `once`: plays, then holds the pose. */
  kind: "still" | "once" | "loop";
  /** One play or one loop, in ms. */
  ms: number;
}

export const botFaceMotion: Record<BotFaceState, BotFaceMotion> = {
  idle: { kind: "still", ms: 0 },
  acknowledge: { kind: "once", ms: 650 },
  thinking: { kind: "loop", ms: 3200 },
  working: { kind: "loop", ms: 2400 },
  "needs-you": { kind: "once", ms: 700 },
  blocked: { kind: "once", ms: 800 },
  done: { kind: "once", ms: 800 },
};

/** What an agent's face shows, from what Spade says the agent is doing. */
export function botFaceStateOf(agent: {
  state: "idle" | "working" | "waiting";
  status?: string | undefined;
  problem?: string | undefined;
}): BotFaceState {
  if (agent.state === "waiting") return "needs-you";
  if (agent.state === "working") return agent.status === "Thinking" ? "thinking" : "working";
  if (agent.problem) return "blocked";
  return "idle";
}
