import type { Capabilities, ProviderKind } from "@ace/protocol";
import { effortLabel, type ModelChoice } from "./models.ts";
import type { ProviderState } from "./provider-status.ts";
import { providerNames } from "./providers.ts";

/** One model as the model picker lists it, whichever account would run it. */
export interface PickerModel {
  /** `modelKey(provider, id)`: what favorites store and what choosing one hands back. */
  key: string;
  provider: ProviderKind;
  label: string;
  isNew: boolean;
  /** Deprecated by the provider: listed under Legacy models, after the rest. */
  legacy: boolean;
  /** Why it can't be chosen now (every account that serves it is at its limit). */
  unavailable?: string | undefined;
}

/** The picker's left column: Favorites, or one provider. */
export type PickerTab = "favorites" | ProviderKind;

/** What the picker lists: current models first, then from `legacyFrom` on the legacy ones. */
export interface PickerList {
  rows: readonly PickerModel[];
  /** Index of the first legacy row; `rows.length` when there are none. */
  legacyFrom: number;
}

/** The words of a search, lowercased; a row matches when it contains every one. */
function words(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function haystack(model: PickerModel): string {
  const id = model.key.slice(model.key.indexOf("\u0000") + 1);
  return `${model.label} ${id} ${providerNames[model.provider]}`.toLocaleLowerCase();
}

/**
 * The rows for a tab, or for a search across every provider when the query has words.
 * Favorites keep the order they were starred in; elsewhere the catalog's order holds. Legacy
 * models always come last, so the ⌘1…⌘9 shortcuts land on current ones.
 */
export function pickerList(
  models: readonly PickerModel[],
  input: { tab: PickerTab; query: string; favorites: readonly string[] },
): PickerList {
  const terms = words(input.query);
  let found: PickerModel[];
  if (terms.length) {
    found = models.filter((model) => {
      const text = haystack(model);
      return terms.every((term) => text.includes(term));
    });
  } else if (input.tab === "favorites") {
    const byKey = new Map(models.map((model) => [model.key, model]));
    found = input.favorites.flatMap((key) => {
      const model = byKey.get(key);
      return model ? [model] : [];
    });
  } else {
    found = models.filter((model) => model.provider === input.tab);
  }
  const current = found.filter((model) => !model.legacy);
  return {
    rows: [...current, ...found.filter((model) => model.legacy)],
    legacyFrom: current.length,
  };
}

/** At most this many favorites are kept; the oldest give way. */
export const favoriteLimit = 50;

/** Star or unstar a model: a new favorite goes last. */
export function toggleFavorite(favorites: readonly string[], key: string): string[] {
  if (favorites.includes(key)) return favorites.filter((entry) => entry !== key);
  return [...favorites, key].slice(-favoriteLimit);
}

/** A provider in the picker's column, and why it is dimmed when it is. */
export interface PickerProvider {
  provider: ProviderKind;
  /** Set when the provider has nothing to pick: not installed, signed out, no models. */
  reason: string | undefined;
}

/**
 * The column's providers: every one discovery reports, in its order, then any other provider
 * the list has models for. Each is dimmed, with a reason, when it has no model to pick.
 */
export function pickerProviders(
  models: readonly PickerModel[],
  statuses: readonly { provider: ProviderKind; state: ProviderState }[],
): PickerProvider[] {
  const listed = new Set(models.map((model) => model.provider));
  const seen = new Set<ProviderKind>();
  const out: PickerProvider[] = [];
  const add = (provider: ProviderKind, state: ProviderState | undefined) => {
    if (seen.has(provider)) return;
    seen.add(provider);
    const name = providerNames[provider];
    const reason =
      state === "not_installed"
        ? `${name} isn't installed`
        : state === "signed_out" && !listed.has(provider)
          ? `Sign in to ${name} to use its models`
          : listed.has(provider)
            ? undefined
            : `${name} lists no models yet`;
    out.push({ provider, reason });
  };
  for (const status of statuses) add(status.provider, status.state);
  for (const model of models) add(model.provider, undefined);
  return out;
}

/**
 * The `serviceTier` that asks for a model's standard speed: "default" where the catalog runs it
 * fast unless asked otherwise, else none (leaving the tier out is already standard).
 */
export function speedOffTier(
  model: { fastTier: string | undefined; fastDefault?: boolean | undefined } | undefined,
): string | undefined {
  return model?.fastTier !== undefined && model.fastDefault ? "default" : undefined;
}

/** The speed toggle: the fast tier on offer, whether it is on, or why it can't change. */
export interface SpeedControl {
  tier: string | undefined;
  /** The `serviceTier` that turns speed off: none when the model is standard by default. */
  off: string | undefined;
  on: boolean;
  reason: string | undefined;
}

/**
 * Speed for a model: on when the selection names its fast tier, or names none and the catalog
 * runs the model fast by default. A thread that already exists also needs its provider to take
 * `serviceTier` as a session option.
 */
export function speedControl(input: {
  model:
    | {
        label: string;
        provider: ProviderKind;
        fastTier: string | undefined;
        fastDefault?: boolean | undefined;
      }
    | undefined;
  /** What the selection asks for now (`options.serviceTier`). */
  current: unknown;
  /** A running thread's capabilities; omitted for a thread that hasn't started. */
  capabilities?: Pick<Capabilities, "sessionOptions" | "launchOptions"> | undefined;
  running?: boolean;
}): SpeedControl {
  const { model } = input;
  const tier = model?.fastTier;
  const off = speedOffTier(model);
  const on =
    tier !== undefined &&
    (input.current === undefined ? off !== undefined : input.current === tier);
  const blocked = (reason: string): SpeedControl => ({ tier, off, on, reason });
  if (!model) return blocked("Choose a model first");
  if (!tier) return blocked(`${model.label} has no faster tier`);
  if (
    input.running &&
    (!input.capabilities?.sessionOptions ||
      !input.capabilities.launchOptions?.includes("serviceTier"))
  )
    return blocked(`${providerNames[model.provider]} sets speed only when a thread starts`);
  return { tier, off, on, reason: undefined };
}

type Options = Readonly<Record<string, string | number | boolean | null>>;

/**
 * The options the next message carries after a change: `current` (what the composer holds,
 * pending or not) with `patch` applied, where `undefined` removes a key. Undefined when that is
 * just `base`, what the thread already runs with, so a message with nothing changed carries no
 * options and keeps its normal delivery.
 */
export function nextOptions(
  base: Options,
  current: Options,
  patch: Readonly<Record<string, string | undefined>>,
): Record<string, string | number | boolean | null> | undefined {
  const next: Record<string, string | number | boolean | null> = { ...current };
  for (const [key, value] of Object.entries(patch))
    if (value === undefined) delete next[key];
    else next[key] = value;
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  for (const key of keys) if (base[key] !== next[key]) return next;
  return undefined;
}

/**
 * What the model chip says to assistive tech and in its tooltip: "Opus 4.1, personal, High
 * effort". An effort ace assumes rather than one the daemon reported says so.
 */
export function modelControlName(input: {
  model: string;
  account?: string | undefined;
  effort: string | undefined;
  /** `effort` is the default as far as ace knows, not what the daemon reported. */
  effortDefault?: boolean;
  hasEfforts: boolean;
  fast?: boolean;
}): string {
  const effort = input.effort
    ? `${effortLabel(input.effort)} effort${input.effortDefault ? " (default)" : ""}`
    : input.hasEfforts
      ? "provider default effort"
      : undefined;
  return [input.model, input.account, effort, input.fast ? "fast" : undefined]
    .filter(Boolean)
    .join(", ");
}

/**
 * A running thread's picker rows: each model once, whichever accounts serve it, unavailable
 * (with when it frees up) only when every one of those accounts is at its limit.
 */
export function pickerModelsFromChoices(
  choices: readonly ModelChoice[],
  limitReached: (resetsAt: number | undefined) => string,
): PickerModel[] {
  const byKey = new Map<string, ModelChoice[]>();
  for (const choice of choices) {
    const group = byKey.get(choice.key);
    if (group) group.push(choice);
    else byKey.set(choice.key, [choice]);
  }
  return [...byKey.values()].flatMap((group) => {
    const first = group[0];
    if (!first) return [];
    const exhausted = group.every((choice) => choice.exhausted);
    const resets = group.flatMap((choice) =>
      choice.resetsAt === undefined ? [] : [choice.resetsAt],
    );
    return [
      {
        key: first.key,
        provider: first.provider,
        label: first.model,
        isNew: first.isNew,
        legacy: first.legacy,
        unavailable: exhausted
          ? limitReached(resets.length ? Math.min(...resets) : undefined)
          : undefined,
      },
    ];
  });
}

/** The choice that runs a picked model: on `account` when it serves it with headroom, else any. */
export function choiceForModel(
  choices: readonly ModelChoice[],
  key: string,
  account: string | undefined,
): ModelChoice | undefined {
  const serving = choices.filter((choice) => choice.key === key);
  return (
    serving.find((choice) => choice.accountId === account && !choice.exhausted) ??
    serving.find((choice) => !choice.exhausted)
  );
}

/** What a reconciliation dropped from the next message, for saying so. */
export type DroppedChoice = "effort" | "speed";

/**
 * Effort and speed picked for the next message, checked again after the thread moved to
 * another model, account or provider (here or on another device). What the new model still
 * takes is kept, over its own `base` options; what it doesn't is dropped and named, so the
 * person can be told rather than have an unsupported value go out.
 */
export function reconcileNextOptions(input: {
  base: Options;
  pending: Options;
  efforts: readonly string[];
  /** Effort can change on the thread now (`threadEffortControl` gave no reason). */
  effortAllowed: boolean;
  fastTier: string | undefined;
  speedAllowed: boolean;
}): {
  options: Record<string, string | number | boolean | null> | undefined;
  dropped: DroppedChoice[];
} {
  const patch: Record<string, string | undefined> = {};
  const dropped: DroppedChoice[] = [];
  const effort = input.pending["effort"];
  if (typeof effort === "string" && effort !== input.base["effort"]) {
    if (input.effortAllowed && input.efforts.includes(effort)) patch["effort"] = effort;
    else dropped.push("effort");
  }
  const tier = input.pending["serviceTier"];
  if (typeof tier === "string" && tier !== input.base["serviceTier"]) {
    const known = tier === input.fastTier || tier === "default";
    if (input.speedAllowed && input.fastTier !== undefined && known) patch["serviceTier"] = tier;
    else dropped.push("speed");
  }
  return { options: nextOptions(input.base, input.base, patch), dropped };
}
