/*
 * Cowork: the person and an agent use one computer at the same time (a screen, a browser tab, a
 * simulator, a Spade bot's computer; ADR 0143). When both act on it, the agent yields: its actions wait
 * while the person's input is recent. Exclusive (Take over, Take control) is the explicit mode
 * where only the person acts and the agent is paused. These are the words and the pointer every
 * view of it shares.
 */

import type { AgentPointer, AgentPointerKind } from "@ace/protocol";

export type { AgentPointer } from "@ace/protocol";

/** How long the agent's pointer stays after its last action, then fades. */
export const agentPointerFadeMs = 1500;

const pointerKinds: readonly AgentPointerKind[] = ["move", "click", "drag", "scroll", "type"];
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A pointer from JSON (Spade's `agent_pointer`); undefined when it isn't one. */
export function parseAgentPointer(value: unknown): AgentPointer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fields = value as Record<string, unknown>;
  const kind = pointerKinds.find((each) => each === fields.kind) ?? "move";
  if (!finite(fields.x) || !finite(fields.y) || !finite(fields.at)) return undefined;
  return { x: fields.x, y: fields.y, kind, at: fields.at };
}

/** How much longer the pointer shows at `now`, in ms; 0 once it has faded. */
export function agentPointerShownFor(pointer: AgentPointer | undefined, now: number): number {
  if (!pointer) return 0;
  return Math.max(0, pointer.at + agentPointerFadeMs - now);
}

/**
 * Who has the computer now: `yours` in exclusive mode, `waiting` while the agent yields to the
 * person's recent input, `working` while the agent uses it, `idle` otherwise.
 */
export type CoworkState = "yours" | "waiting" | "working" | "idle";

export function coworkState(facts: {
  exclusive: boolean;
  personActive: boolean;
  agentActive: boolean;
}): CoworkState {
  if (facts.exclusive) return "yours";
  if (facts.personActive && facts.agentActive) return "waiting";
  return facts.agentActive ? "working" : "idle";
}

/** The status line, one short sentence. */
export function coworkLine(state: CoworkState, agent: string): string {
  if (state === "yours") return "You have it";
  if (state === "waiting") return `${agent} is waiting for you`;
  if (state === "working") return `${agent} is working here`;
  return `${agent} isn't using it now`;
}

/** The letter drawn in the agent's pointer when it has no face of its own. */
export function agentInitial(name: string): string {
  const first = name.trim().match(/\p{L}|\p{N}/u)?.[0];
  return first ? first.toLocaleUpperCase() : "·";
}
