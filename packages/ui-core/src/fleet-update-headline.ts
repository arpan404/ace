import {
  cannotUpdateSentence,
  fleetUpdateOffer,
  fleetUpdatePlan,
  type FleetUpdatePlan,
} from "./fleet-update-plan.ts";
import {
  fleetRunExpired,
  fleetRunLine,
  fleetRunState,
  fleetRunSummary,
  type FleetUpdateRun,
} from "./fleet-update-run.ts";
import { machineUpdateLine, type UpdateLine, type UpdateMachine } from "./machine-update-words.ts";

/*
 * What Settings › Fleet says about updates, from the machines and the run this window keeps:
 * one line (a run's countdown, or the offer with Update all), the sentence naming who it
 * can't reach, and each machine row's own words.
 */

export type FleetUpdateAction = "all" | "all-now";

export interface FleetUpdateHeadline {
  title: string;
  note: string | null;
  actions: readonly FleetUpdateAction[];
}

export function fleetUpdateHeadline(
  machines: readonly UpdateMachine[],
  run: FleetUpdateRun | null,
  now: number,
  plan: FleetUpdatePlan = fleetUpdatePlan(machines),
): FleetUpdateHeadline | null {
  const summary = run && !fleetRunExpired(run, now) ? fleetRunSummary(run, machines, now) : null;
  const inRun = new Set(run?.machines.map((entry) => entry.id));
  if (run && summary && !summary.done)
    return {
      title: summary.words,
      note: cannotUpdateSentence(plan.cannot.filter((entry) => !inRun.has(entry.id))),
      actions: [],
    };
  const offer = fleetUpdateOffer(plan);
  const note = cannotUpdateSentence(plan.cannot);
  if (offer) return { title: offer, note, actions: ["all", "all-now"] };
  if (summary) return { title: summary.words, note: null, actions: [] };
  const waiting = plan.cannot.filter((entry) => entry.version !== null && entry.why !== "offline");
  if (waiting.length)
    return {
      title:
        waiting.length === 1
          ? `${waiting[0]?.name ?? "A machine"} has an update`
          : `${waiting.length} machines have an update`,
      note,
      actions: [],
    };
  return null;
}

/**
 * A machine row's update words: its place in the run while there is one, else its own state.
 * Null when there's nothing to say.
 */
export function fleetMachineLine(
  machine: UpdateMachine,
  run: FleetUpdateRun | null,
  now: number,
): UpdateLine | null {
  const entry = run?.machines.find((each) => each.id === machine.id);
  if (!run || !entry) return machineUpdateLine(machine);
  const state = fleetRunState(run, entry, machine, now);
  if (state.kind === "expired" && !state.newer) return machineUpdateLine(machine);
  return fleetRunLine(state, entry, machine);
}
