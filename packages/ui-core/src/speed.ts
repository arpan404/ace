import type { Capabilities, CatalogModel, ProviderKind } from "@ace/protocol";
import { providerNames } from "./providers.ts";

/** Service speeds, slowest first: the order the speed control cycles through. */
export const speedOrder = ["standard", "fast", "ultrafast"] as const;
export type Speed = (typeof speedOrder)[number];

/** One speed a model can run at, and the `serviceTier` option that asks for it. */
export interface SpeedTier {
  speed: Speed;
  /** The catalog's name for it ("Fast", "Priority"). */
  name: string;
  /** The `serviceTier` to send; undefined when leaving the option out already means this speed. */
  value: string | undefined;
}

const speedRank = (speed: Speed) => speedOrder.indexOf(speed);

type TierSource = Pick<CatalogModel, "serviceTiers" | "defaultTier">;
type ModelTier = CatalogModel["serviceTiers"][number];

/** A catalog tier ace can ask for: one named by a `serviceTier` launch option. */
const requestable = (tier: ModelTier) => {
  const value = tier.parameters["serviceTier"];
  return typeof value === "string" ? value : undefined;
};

/**
 * The speeds a model offers, slowest first, one per speed. Only tiers set through a
 * `serviceTier` launch option count (a thread can't be started or switched with anything else).
 * Empty when there is nothing faster than standard to choose. Standard is always first: its own
 * tier when the catalog lists one, else "default" when the catalog runs the model faster unless
 * asked otherwise, else no option at all.
 */
export function speedTiers(model: TierSource): readonly SpeedTier[] {
  const faster = new Map<Speed, SpeedTier>();
  let standard: SpeedTier | undefined;
  for (const tier of model.serviceTiers) {
    const value = requestable(tier);
    if (value === undefined) continue;
    if (tier.speed === "standard") standard ??= { speed: "standard", name: tier.name, value };
    else if (tier.speed && !faster.has(tier.speed))
      faster.set(tier.speed, { speed: tier.speed, name: tier.name, value });
  }
  if (!faster.size) return [];
  const fasterByDefault = model.serviceTiers.some(
    (tier) => tier.id === model.defaultTier && tier.speed !== "standard" && requestable(tier),
  );
  return [
    standard ?? {
      speed: "standard",
      name: "Standard",
      value: fasterByDefault ? "default" : undefined,
    },
    ...[...faster.values()].toSorted((a, b) => speedRank(a.speed) - speedRank(b.speed)),
  ];
}

/** The speed the catalog runs a model at when the selection asks for none. */
export function defaultSpeed(model: TierSource): Speed {
  const tier = model.serviceTiers.find((entry) => entry.id === model.defaultTier);
  return tier?.speed && requestable(tier) ? tier.speed : "standard";
}

/** The speed a selection's `serviceTier` asks for, given the model's tiers. */
export function selectedSpeed(
  tiers: readonly SpeedTier[],
  fallback: Speed,
  current: unknown,
): Speed {
  if (!tiers.length) return "standard";
  if (current === undefined) return fallback;
  return tiers.find((tier) => tier.value === current)?.speed ?? "standard";
}

/** The `serviceTier` that asks for `speed`; undefined leaves the option out. */
export function speedOption(tiers: readonly SpeedTier[], speed: Speed): string | undefined {
  return tiers.find((tier) => tier.speed === speed)?.value;
}

/** The model's speed control: the tiers on offer, the one in effect, or why it can't change. */
export interface SpeedControl {
  /** Slowest first; empty or a single tier means there's nothing to choose. */
  tiers: readonly SpeedTier[];
  speed: Speed;
  reason: string | undefined;
}

/**
 * Speed for a model: the tier the selection names, or the catalog's default when it names none.
 * A thread that already exists also needs its provider to take `serviceTier` as a session option.
 */
export function speedControl(input: {
  model:
    | {
        label: string;
        provider: ProviderKind;
        speeds: readonly SpeedTier[];
        defaultSpeed: Speed;
      }
    | undefined;
  /** What the selection asks for now (`options.serviceTier`). */
  current: unknown;
  /** A running thread's capabilities; omitted for a thread that hasn't started. */
  capabilities?: Pick<Capabilities, "sessionOptions" | "launchOptions"> | undefined;
  running?: boolean;
}): SpeedControl {
  const { model } = input;
  const tiers = model?.speeds ?? [];
  const speed = selectedSpeed(tiers, model?.defaultSpeed ?? "standard", input.current);
  const blocked = (reason: string): SpeedControl => ({ tiers, speed, reason });
  if (!model) return blocked("Choose a model first");
  if (tiers.length < 2) return blocked(`${model.label} has no faster tier`);
  if (
    input.running &&
    (!input.capabilities?.sessionOptions ||
      !input.capabilities.launchOptions?.includes("serviceTier"))
  )
    return blocked(`${providerNames[model.provider]} sets speed only when a thread starts`);
  return { tiers, speed, reason: undefined };
}

/** How a speed reads ("Ultrafast"). */
export function speedLabel(speed: Speed): string {
  return speed === "ultrafast" ? "Ultrafast" : speed === "fast" ? "Fast" : "Standard";
}
