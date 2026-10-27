import type { ProviderKind, ProviderStatus as DiscoveryStatus } from "@ace/protocol";
import type { AccountSummary } from "@ace/protocol/accounts";
import type { z } from "zod";
import { accountView, type AccountView } from "./accounts.ts";
import type { ModelCatalog } from "./model-catalog-read.ts";
import {
  effortLabel,
  newThreadOptions,
  resolveEffort,
  selectNewThreadModel,
  type AccountOption,
  type ModelOption,
} from "./models.ts";
import {
  pickerModel,
  pickerProviders,
  type PickerModel,
  type PickerProvider,
} from "./model-picker.ts";
import { providerAccountModel } from "./provider-account-model.ts";
import { catalogSignal } from "./provider-readiness.ts";
import { providerAccountState, type ProviderState } from "./provider-status.ts";
import { providerDisplayName } from "./providers.ts";
import { speedLabel, speedOption, type Speed } from "./speed.ts";
import type { StatusDisplay, StatusToken } from "./mobile-status.ts";

/*
 * The native New thread sheet (issue #560): which coding agents a thread can start on, by the
 * same readiness, account and catalog rules the web's New thread uses, and which projects come
 * first. Native code draws these rows; it never decides whether a CLI is usable.
 */

export interface NewThreadModelRow {
  /** The model's identity (`modelKey`); the bridge resolves it again before sending. */
  key: string;
  label: string;
  /** The account (catalog instance) serving it. */
  account: string;
  efforts: { id: string; label: string }[];
  defaultEffort: string | undefined;
  /** Speeds it can start at, slowest first; empty when there is nothing faster. */
  speeds: { speed: Speed; label: string }[];
  defaultSpeed: Speed;
  /** Its account's default model. */
  isDefault: boolean;
  /** An older or deprecated model, listed after the current ones. */
  legacy: boolean;
}

export interface NewThreadProviderRow {
  provider: ProviderKind;
  name: string;
  /** A thread can start on it now. */
  ready: boolean;
  /** Its CLI is on the computer, ready or not. */
  installed: boolean;
  /** Its readiness as the web's provider pickers name it (`providerChoiceLabel`). */
  state: ProviderState;
  status: StatusDisplay;
  /** Why it can't be picked, in words; absent when it can. */
  reason: string | undefined;
  accounts: { id: string; label: string; usage: string }[];
  models: NewThreadModelRow[];
}

/** The rows the sheet shows, with the options the bridge resolves a choice against. */
export interface NewThreadAgents {
  providers: NewThreadProviderRow[];
  models: readonly ModelOption[];
  accounts: readonly AccountOption[];
  /** The same models, providers and accounts as the web's picker sees them (`newThreadTabs`). */
  picker: {
    models: PickerModel[];
    providers: PickerProvider[];
    accounts: AccountView[];
    now: number;
  };
}

const reasons: Partial<Record<string, string>> = {
  not_installed: "Not installed on this computer",
  signed_out: "Signed out. Sign in on your computer.",
  needs_update: "Needs an update on your computer",
  limited: "Usage limit reached",
  attention: "Needs attention on your computer",
  unknown: "Checking sign-in…",
};

const tokens: Partial<Record<string, StatusToken>> = {
  ready: "done",
  signed_out: "needsYou",
  limited: "waiting",
  needs_update: "failed",
  attention: "failed",
};

/**
 * Every coding agent the machine reports (`providers.request` readiness), in its order, joined
 * with its accounts (`accounts.list`) and the model catalog (`models.list`) the way the web's
 * provider statuses join them. One that isn't installed, is signed out, needs an update or lists
 * no models is still listed, unready, with the reason. Turned-off CLIs are left out.
 */
export function newThreadAgents(input: {
  statuses: readonly DiscoveryStatus[];
  accounts: readonly z.infer<typeof AccountSummary>[];
  catalog: ModelCatalog;
  now: number;
}): NewThreadAgents {
  const views = input.accounts.map(accountView);
  const joined = input.statuses
    .filter((row) => row.enabled !== false)
    .map((row) => {
      const model = providerAccountModel({
        provider: row.provider,
        accounts: views,
        row,
        catalog: catalogSignal(input.catalog.models, input.catalog.instances, row.provider),
        now: input.now,
      });
      return { row, model, state: providerAccountState(model) };
    });
  const reconciled: AccountView[] = joined.flatMap((entry) => entry.model.accounts);
  const options = newThreadOptions(
    input.catalog.models,
    reconciled,
    joined.map((entry) => ({ provider: entry.row.provider, state: entry.state })),
  );
  const providers = joined.map(({ row, model, state }): NewThreadProviderRow => {
    const own = options.models.filter((option) => option.provider === row.provider);
    const ready = state === "ready" && own.length > 0;
    const label = model.view?.label ?? "Unknown";
    return {
      provider: row.provider,
      name: providerDisplayName(row.provider),
      ready,
      installed: state !== "not_installed",
      state,
      status: {
        label: ready ? "Ready" : label,
        token: ready ? "done" : (tokens[state] ?? "neutral"),
      },
      reason: ready
        ? undefined
        : state === "ready"
          ? "No models listed on this computer"
          : (reasons[state] ?? label),
      accounts: options.accounts
        .filter((account) => account.provider === row.provider)
        .map((account) => ({ id: account.id, label: account.label, usage: account.usage })),
      models: own.map((option) => ({
        key: option.key,
        label: option.label,
        account: option.account,
        efforts: option.efforts.map((id) => ({ id, label: effortLabel(id) })),
        defaultEffort: option.defaultEffort,
        speeds: option.speeds.map((tier) => ({ speed: tier.speed, label: speedLabel(tier.speed) })),
        defaultSpeed: option.defaultSpeed,
        isDefault: option.isDefault,
        legacy: option.legacy,
      })),
    };
  });
  const listed = options.models.map((option) => pickerModel(option, option.label, option.account));
  return {
    providers,
    models: options.models,
    accounts: options.accounts,
    picker: {
      models: listed,
      providers: pickerProviders(
        listed,
        joined.map((entry) => ({ provider: entry.row.provider, state: entry.state })),
      ),
      accounts: reconciled,
      now: input.now,
    },
  };
}

/** What the person picked; any part may be missing or no longer offered. */
export interface NewThreadChoice {
  provider?: string | undefined;
  model?: string | undefined;
  account?: string | undefined;
  effort?: string | undefined;
  /** A speed the person turned on; undefined runs at the catalog's default. */
  speed?: string | undefined;
}

export type NewThreadStart =
  | {
      ok: true;
      provider: ProviderKind;
      model: ModelOption;
      effort: string | undefined;
      /** The `serviceTier` the picked speed asks for; undefined leaves the option out. */
      serviceTier: string | undefined;
    }
  | { ok: false; reason: string };

/**
 * The choice as it can start: the picked agent when it is ready (else the first ready one when
 * none was picked), then the account and model `selectNewThreadModel` gives, then the model's
 * effort. A picked agent that isn't ready is refused with its reason, never swapped silently.
 */
export function selectNewThreadAgent(
  agents: NewThreadAgents,
  choice: NewThreadChoice,
): NewThreadStart {
  const picked = agents.providers.find((row) => row.provider === choice.provider);
  if (choice.provider !== undefined && !picked)
    return { ok: false, reason: "That coding agent isn't on this computer." };
  if (picked && !picked.ready)
    return { ok: false, reason: `${picked.name}: ${picked.reason ?? "Not ready"}` };
  const row = picked ?? agents.providers.find((entry) => entry.ready);
  if (!row) return { ok: false, reason: "No coding agent is ready on this computer." };
  const { model } = selectNewThreadModel({
    models: agents.models,
    accounts: agents.accounts,
    provider: row.provider,
    model: choice.model,
    account: choice.account,
  });
  if (!model) return { ok: false, reason: `${row.name}: No models listed on this computer` };
  const effort = resolveEffort(model.efforts, choice.effort, model.defaultEffort);
  const speed = model.speeds.find((tier) => tier.speed === choice.speed)?.speed;
  const serviceTier = speed ? speedOption(model.speeds, speed) : undefined;
  return { ok: true, provider: row.provider, model, effort, serviceTier };
}

/** How many of an agent's models the picker shows before "More models". */
export const leadingModels = 4;

/**
 * One agent's models as the picker lists them: the account's default first, then the other
 * current models in the catalog's order, then legacy ones. The order never depends on the pick,
 * so choosing a model doesn't move the rows. `lead` rows show at once and the rest wait behind
 * "More models"; a list barely longer than that shows whole, and the lead always reaches the
 * model in use, even when it is legacy.
 */
export function newThreadModelList(
  models: readonly NewThreadModelRow[],
  current: { key: string; account?: string | undefined } | undefined,
): { models: NewThreadModelRow[]; lead: number } {
  const defaults = models.filter((row) => row.isDefault && !row.legacy);
  const others = models.filter((row) => !row.isDefault && !row.legacy);
  const legacy = models.filter((row) => row.legacy);
  const ordered = [...defaults, ...others, ...legacy];
  const inUse = ordered.findIndex(
    (row) =>
      !!current && row.key === current.key && (!current.account || row.account === current.account),
  );
  const nonLegacy = ordered.length - legacy.length;
  const lead =
    ordered.length <= leadingModels + 1
      ? ordered.length
      : Math.max(1, Math.min(leadingModels, nonLegacy), inUse + 1);
  return { models: ordered, lead };
}

/**
 * The agents the model picker offers: a CLI that isn't on the computer is left out, unless the
 * draft already names it; a signed-out or limited one stays so the picker can say why.
 */
export function newThreadPickerAgents(
  providers: readonly NewThreadProviderRow[],
  keep: string | undefined,
): NewThreadProviderRow[] {
  return providers.filter((row) => row.installed || row.provider === keep);
}

export interface NewThreadProject {
  id: string;
  name: string;
  path: string;
  /** Has a thread on this machine; recent projects come first. */
  recent: boolean;
}

/**
 * Projects for the picker: those with the most recent thread activity first, then the rest by
 * name. `activity` is each thread's project and when it last moved.
 */
export function newThreadProjects(
  projects: readonly { id: string; name: string; path: string }[],
  activity: Iterable<{ workspaceId: string; at: number }>,
): NewThreadProject[] {
  const latest = new Map<string, number>();
  for (const entry of activity)
    latest.set(entry.workspaceId, Math.max(latest.get(entry.workspaceId) ?? 0, entry.at));
  return projects
    .map((project) => ({
      id: project.id,
      name: project.name || project.id,
      path: project.path,
      recent: latest.has(project.id),
      at: latest.get(project.id) ?? -1,
    }))
    .toSorted((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    .map(({ at: _at, ...row }) => row);
}
