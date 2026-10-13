import type { ModelSource, ProviderKind } from "@ace/protocol";
import { modelLine } from "./model-label.ts";
import { effortLabel, type ModelChoice, type ModelPlacement } from "./models.ts";
import type { ProviderState } from "./provider-status.ts";
import { providerNames } from "./providers.ts";
import type { Speed, SpeedTier } from "./speed.ts";

/** One model on one account (or source) as the model picker lists it. */
export interface PickerModel {
  aliasKeys?: readonly string[] | undefined;
  free?: boolean | undefined;
  /** `modelKey(provider, id)`: what favorites store and what choosing one hands back. */
  key: string;
  provider: ProviderKind;
  /** The human name, "Haiku 4.5"; never a raw id. */
  label: string;
  /** Quiet secondary text beside the name: a snapshot date, "latest". */
  detail?: string | undefined;
  isNew: boolean;
  /** An older model, or one its provider deprecated: listed under Legacy models. */
  legacy: boolean;
  /** Its account's (or instance's) default model. */
  isDefault?: boolean | undefined;
  /** The default because the person chose it in Settings. */
  userDefault?: boolean | undefined;
  /** Opaque ascending order within the provider and account. */
  sortKey?: string | undefined;
  /** The catalog instance (account) serving this row. */
  instance?: string | undefined;
  /** Where the model comes from, which groups it: an account, local, a subscription, a key. */
  source?: ModelSource | undefined;
  /** Why it can't be chosen now (every account that serves it is at its limit). */
  unavailable?: string | undefined;
  /** A saved choice the catalog no longer lists: shown first, apart from runnable models. */
  vanished?: boolean | undefined;
}

/** The picker's left column: Favorites, or one provider. */
export type PickerTab = "favorites" | ProviderKind;

/** A search or Favorites: current models first, then from `legacyFrom` on the legacy ones. */
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
  return `${model.label} ${model.detail ?? ""} ${model.source?.label ?? ""} ${id} ${providerNames[model.provider]}`.toLocaleLowerCase();
}

/**
 * One row per model where accounts don't matter (a search, Favorites): one that can take work,
 * on `instance` (the account in use) where it can, so a model is unavailable only when every
 * account serving it is.
 */
function distinctModels(
  models: readonly PickerModel[],
  instance: string | undefined,
): PickerModel[] {
  const score = (model: PickerModel) =>
    (model.unavailable ? 0 : 2) + (model.instance === instance ? 1 : 0);
  const byKey = new Map<string, PickerModel>();
  for (const model of models) {
    const kept = byKey.get(model.key);
    if (!kept || score(model) > score(kept)) byKey.set(model.key, model);
  }
  return [...byKey.values()];
}

/**
 * A search across every provider, or Favorites in the order they were starred: each model once,
 * legacy ones last, so the ⌘1…⌘9 shortcuts land on current ones. A provider's own tab lists
 * its source groups instead (`pickerGroups`).
 */
export function pickerList(
  models: readonly PickerModel[],
  input: {
    query: string;
    favorites: readonly string[];
    /** The account in use, whose row stands for a model several accounts list. */
    instance?: string | undefined;
  },
): PickerList {
  const terms = words(input.query);
  const distinct = distinctModels(models, input.instance);
  let found: PickerModel[];
  if (terms.length) {
    found = models.filter((model) => {
      const text = haystack(model);
      return terms.every((term) => text.includes(term));
    });
  } else {
    const byKey = new Map(distinct.map((model) => [model.key, model]));
    for (const model of distinct)
      for (const alias of model.aliasKeys ?? []) if (!byKey.has(alias)) byKey.set(alias, model);
    const seen = new Set<string>();
    found = input.favorites.flatMap((key) => {
      const model = byKey.get(key);
      if (!model || seen.has(model.key)) return [];
      seen.add(model.key);
      return [model];
    });
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
 * What the model chip says to assistive tech, "Opus 4.1, personal, High effort", and with
 * `provider` in its tooltip, "Claude Code · Opus 4.1, personal, High effort". An effort ace
 * assumes rather than one the daemon reported says so.
 */
export function modelControlName(input: {
  model: string;
  /** Name the provider first (`modelLine`), where nothing beside the name shows it. */
  provider?: ProviderKind | undefined;
  account?: string | undefined;
  effort: string | undefined;
  /** `effort` is the default as far as ace knows, not what the daemon reported. */
  effortDefault?: boolean;
  hasEfforts: boolean;
  speed?: Speed | undefined;
}): string {
  const effort = input.effort
    ? `${effortLabel(input.effort)} effort${input.effortDefault ? " (default)" : ""}`
    : input.hasEfforts
      ? "provider default effort"
      : undefined;
  const model = input.provider ? modelLine(input.provider, input.model) : input.model;
  const speed = input.speed && input.speed !== "standard" ? input.speed : undefined;
  return [model, input.account, effort, speed].filter(Boolean).join(", ");
}

/** A choice or New thread option as a picker row. */
export function pickerModel(
  row: ModelPlacement & {
    key: string;
    provider: ProviderKind;
    isNew: boolean;
    legacy: boolean;
    isDefault: boolean;
  },
  label: string,
  instance: string | undefined,
  unavailable?: string,
): PickerModel {
  return {
    key: row.key,
    aliasKeys: row.aliasKeys,
    provider: row.provider,
    label,
    detail: row.detail,
    isNew: row.isNew,
    free: row.free,
    legacy: row.legacy,
    isDefault: row.isDefault,
    userDefault: row.userDefault,
    sortKey: row.sortKey,
    instance,
    source: row.source,
    unavailable,
  };
}

/**
 * A running thread's picker rows: each model on each account that serves it, unavailable (with
 * when it frees up) while that account is at its limit. Where accounts don't matter (a search,
 * Favorites) a model is unavailable only when every account serving it is.
 */
export function pickerModelsFromChoices(
  choices: readonly ModelChoice[],
  limitReached: (resetsAt: number | undefined) => string,
): PickerModel[] {
  return choices.map((choice) =>
    pickerModel(
      choice,
      choice.model,
      choice.accountId,
      choice.exhausted ? limitReached(choice.resetsAt) : undefined,
    ),
  );
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
  /** The model's speeds (`speedTiers`); a tier it doesn't offer is dropped. */
  speeds: readonly SpeedTier[];
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
    const known = input.speeds.length > 1 && input.speeds.some((entry) => entry.value === tier);
    if (input.speedAllowed && known) patch["serviceTier"] = tier;
    else dropped.push("speed");
  }
  return { options: nextOptions(input.base, input.base, patch), dropped };
}

/** A free marker adds information only when the name does not already say Free. */
export function freeModelMarker(model: Pick<PickerModel, "free" | "label">): boolean {
  return !!model.free && !/\bfree\b/i.test(model.label);
}
