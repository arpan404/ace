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

const busy = (state: BotFaceState) => state === "working" || state === "thinking";

/**
 * What the face shows when the agent's live state moves from `previous` to `live`: starting
 * work first acknowledges it (for `botFaceMotion.acknowledge.ms`, then the live state), and
 * finishing work shows done, held until the person has seen it. Anything else shows as it is.
 */
export function botFaceStateAfter(previous: BotFaceState, live: BotFaceState): BotFaceState {
  if (busy(live) && !busy(previous) && previous !== "needs-you") return "acknowledge";
  if (live === "idle" && (busy(previous) || previous === "needs-you")) return "done";
  return live;
}
