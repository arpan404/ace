import {
  betaKeys,
  betaOnAtRest,
  booleanAtRest,
  spadeInThisRelease,
  type BetaFeature,
} from "@ace/settings/beta";
import type { SpadeServiceControl } from "../spade/service-control.ts";
import type { Args } from "./args.ts";
import { saveGlobalSetting } from "./global-setting.ts";
import { spadeNotInRelease } from "./spade.ts";
import { usageFailure } from "./output.ts";
import { nearest } from "./suggest.ts";

export const betaFeatures: readonly BetaFeature[] = ["spade", "marketplace"];
const names: Record<BetaFeature, string> = { spade: "Spade", marketplace: "The marketplace" };

/** A FEATURE argument, or a usage error naming the features there are. */
export function betaFeature(word: string | undefined): BetaFeature {
  const found = betaFeatures.find((feature) => feature === word);
  if (found) return found;
  const suggestion = word ? nearest(word, betaFeatures) : undefined;
  throw usageFailure(`FEATURE must be spade or marketplace${word ? `, not ${word}` : ""}.`, {
    code: "bad_argument",
    argument: "FEATURE",
    hint: suggestion ? `Did you mean ${suggestion}?` : "See them with ace feature list.",
  });
}

/** The switches on Settings › Beta, read from the home without writing anything. */
export async function readFeatures(home: string): Promise<Record<BetaFeature, boolean>> {
  const [spade, marketplace] = await Promise.all([
    betaOnAtRest(home, "spade"),
    betaOnAtRest(home, "marketplace"),
  ]);
  return { spade, marketplace };
}

export interface FeatureSwitch {
  feature: BetaFeature;
  on: boolean;
  live: boolean;
  /** Spade's service was stopped here, because no daemon ran to stop it. */
  stopped: boolean;
  /** Spade itself is turned on, so it starts now that the Beta switch is on. */
  started: boolean;
}

/**
 * `ace feature on|off FEATURE`: a switch on Settings › Beta (ADR 0139, amended), saved as the
 * global `beta.*` setting. A running daemon applies a change at once; one that isn't running
 * reads it when it starts. Turning Spade off stops its service (here, when no daemon runs) but
 * keeps its data and its `spade.enabled` setting; turning the marketplace off keeps what was
 * installed from it.
 */
export async function switchFeature(
  args: Args,
  home: string,
  feature: BetaFeature,
  on: boolean,
  service: () => SpadeServiceControl,
): Promise<FeatureSwitch> {
  if (feature === "spade" && on && !spadeInThisRelease) throw spadeNotInRelease();
  const live = await saveGlobalSetting(args, home, betaKeys[feature], on, names[feature]);
  if (feature === "marketplace") return { feature, on, live, stopped: false, started: false };
  // A running daemon stops or starts Spade's service itself. With none, turning Spade off stops
  // the service here, as the daemon would; `spade.enabled` and Spade's data stay.
  const stopped = !on && !live && (await service().state()) !== "absent";
  if (stopped) await service().remove();
  const started = on && (await booleanAtRest(home, "spade.enabled")) === true;
  return { feature, on, live, stopped, started };
}
