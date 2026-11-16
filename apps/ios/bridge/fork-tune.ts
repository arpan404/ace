import type { ExecutionOptions } from "@ace/protocol";
import {
  effortLabel,
  effortShortLabel,
  resolveEffort,
  speedLabel,
  speedOption,
  type ModelChoice,
  type Speed,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * Effort and speed for a fork being written in the composer: picked in the model sheet while the
 * fork is open, kept on the fork's draft, and sent with its first message in `thread.fork`'s
 * selection. The thread's own tuning (`TuneFollower`) is never touched. A fork starts a new
 * session, so any level or speed its model lists can be picked. Pure over the fork's model.
 */

/** What was picked for the fork's first turn; undefined keeps its model's default. */
export interface ForkTune {
  effort?: string | undefined;
  speed?: Speed | undefined;
}

/** Whether `model` takes the effort (undefined: back to its default). */
export function forkTakesEffort(model: ModelChoice | undefined, effort: string | undefined) {
  return effort === undefined || (model?.efforts.includes(effort) ?? false);
}

/** Whether `model` runs at `speed`; standard needs no tier. */
export function forkTakesSpeed(model: ModelChoice | undefined, speed: Speed) {
  return speed === "standard" || speedOption(model?.speeds ?? [], speed) !== undefined;
}

/** The session options the fork starts with: only what was picked. */
export function forkOptions(model: ModelChoice | undefined, tune: ForkTune): ExecutionOptions {
  const options: ExecutionOptions = {};
  if (tune.effort !== undefined) options["effort"] = tune.effort;
  const tier =
    tune.speed === undefined || tune.speed === "standard"
      ? undefined
      : speedOption(model?.speeds ?? [], tune.speed);
  if (tier !== undefined) options["serviceTier"] = tier;
  return options;
}

/** The model sheet's tune row (`thread.tune`) for the fork, in place of the thread's own. */
export function forkTuneRow(model: ModelChoice | undefined, tune: ForkTune) {
  const efforts = model?.efforts ?? [];
  const preset = resolveEffort(efforts, undefined, model?.defaultEffort);
  const tiers = model?.speeds ?? [];
  const speedPreset = model?.defaultSpeed ?? "standard";
  return {
    type: "thread.tune",
    efforts: efforts.slice(0, 16).map((id) => ({
      id,
      label: preview(effortLabel(id), 64),
      short: preview(effortShortLabel(id), 32),
    })),
    effort: tune.effort ?? preset ?? "",
    effortDefault: tune.effort === undefined,
    effortReason: "",
    effortPreset: preset ?? "",
    speeds:
      tiers.length > 1
        ? tiers.map((tier) => ({ speed: tier.speed, label: speedLabel(tier.speed) }))
        : [],
    speed: tune.speed ?? speedPreset,
    speedReason: "",
    speedPreset,
    pending: false,
    canReset: false,
    notice: "",
  };
}
