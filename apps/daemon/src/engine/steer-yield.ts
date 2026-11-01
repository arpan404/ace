import { hasRunningForegroundCommand, type Fact, type ThreadState } from "@ace/core";
import type { Capabilities } from "@ace/protocol";
import type { IntentHeader } from "./repository.ts";

/**
 * The run the engine interrupted so a person's steer reaches the model now, and whether the
 * provider took that interrupt. A refused interrupt never retries: the steer falls back to the
 * provider's own steering at the tool boundary.
 */
export interface SteerYield {
  run: string;
  state: "pending" | "refused";
}

/** How a waiting steer reaches the model right now, or `undefined` while it must wait. */
export type SteerRoute = "native" | "yield" | undefined;

/**
 * The person's own steer: one they sent, or a waiting message (an agent's too) they chose to
 * steer in. Delegated results and other daemon input never interrupt work.
 */
export function isPersonSteer(intent: IntentHeader, personChose: boolean): boolean {
  return personChose || intent.trigger === undefined || intent.trigger === "user";
}

/** The provider's native steer reaches the model only once the running tool returns. */
export function steerWaitsForTools(capabilities: Capabilities): boolean {
  return capabilities.steerTiming === "after_tool";
}

/** The root's running turn. */
export function rootRun(state: ThreadState): string | undefined {
  return state.agents[state.rootKey ?? ""]?.activeRun;
}

/** The yield still winding down: its run has not ended yet. */
export function yieldInFlight(state: ThreadState, yielded: SteerYield | undefined): boolean {
  return yielded?.state === "pending" && rootRun(state) === yielded.run;
}

/**
 * Picks how a steerable message goes in. With no foreground command running it goes in now.
 * Where the provider's own steer waits for the running command (Claude Code, Codex, Pi,
 * OpenCode), handing it over now lands it at the next tool boundary and stops nothing, so every
 * steer goes in at once; a person's steer also gets the command out of the way, by moving it to
 * the background where the session can (`backgrounds`), else by interrupting the turn (`yield`)
 * and going in as its next input. Where the provider's steer would cut into the command, only a
 * person's steer goes in; anything else waits for the command to end. While an interrupt winds
 * down, every steer waits for that turn to end.
 */
export function steerRoute(
  steer: { person: boolean },
  state: ThreadState,
  capabilities: Capabilities,
  yielded: SteerYield | undefined,
  backgrounds: boolean,
): SteerRoute {
  if (yieldInFlight(state, yielded)) return undefined;
  if (!hasRunningForegroundCommand(state)) return "native";
  if (!steerWaitsForTools(capabilities)) return steer.person ? "native" : undefined;
  if (!steer.person || backgrounds) return "native";
  const run = rootRun(state);
  if (run === undefined) return "native";
  // The provider refused the interrupt: its own steer lands once the command returns.
  return yielded?.run === run ? "native" : "yield";
}

/**
 * Marks the root's end of the turn the engine interrupted for a steer. That run made way for the
 * person's message: clients show it as continuing into the steer, not as a stop.
 */
export function markYieldedEnd(
  facts: Fact[],
  state: ThreadState,
  yielded: SteerYield | undefined,
): Fact[] {
  if (!yieldInFlight(state, yielded) || !yielded) return facts;
  const nativeId = state.runs[yielded.run]?.nativeId;
  if (!facts.some((fact) => fact.type === "turn.ended")) return facts;
  return facts.map((fact) =>
    fact.type === "turn.ended" &&
    fact.agent === state.rootKey &&
    fact.outcome === "interrupted" &&
    !fact.historical &&
    (fact.nativeTurnId === undefined || nativeId === undefined || fact.nativeTurnId === nativeId)
      ? { ...fact, endedBy: "steer" as const }
      : fact,
  );
}
