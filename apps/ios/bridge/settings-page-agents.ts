import {
  SettingsValues,
  UtilityModelChoice,
  type ProviderKind,
  type SettingsKey,
} from "@ace/protocol";
import { roleKeys } from "@ace/settings/roles";
import {
  agentSettingTitles,
  effortLabel,
  modelKey,
  modelLabel,
  providerChoiceLabel,
  providerNames,
  resolveUtilityModel,
  roleEffortChoices,
  speedLabel,
  startingProvider,
  utilityProviders,
  type ModelCatalog,
  type ModelOption,
} from "@ace/ui-core";
import type { NewThreadAgents } from "@ace/ui-core/mobile";
import {
  lockedReason,
  pageSource,
  type ModelPick,
  type PageChoice,
  type PageRow,
  type ReadValues,
} from "./settings-page-wire.ts";

/*
 * The Agents page rows that depend on the machine's coding agents: the default provider (its
 * installed CLIs, in the web's words), the four roles (provider, model, effort and speed from
 * the machine's model catalog) and the utility model for titles and drafts. Each row's write is
 * checked against this machine's own agents, so a change sent to several machines is refused,
 * in words, where it doesn't fit. Pure: no I/O.
 */

export type Role = "build" | "judgment" | "review" | "verify";
export interface AgentsContext {
  agents: NewThreadAgents;
  catalog: ModelCatalog;
  values: ReadValues;
}
/** The settings one change writes, in order, or why it can't be made. */
export type Writes =
  | { ok: true; writes: [SettingsKey, unknown][] }
  | { ok: false; message: string };

const effortValues = SettingsValues.shape["providers.coder.reasoningEffort"].options;
const tierValues = SettingsValues.shape["providers.coder.tier"].options;
const isEffort = (value: string): value is (typeof effortValues)[number] =>
  (effortValues as readonly string[]).includes(value);
const isTier = (value: string): value is (typeof tierValues)[number] =>
  (tierValues as readonly string[]).includes(value);

const text = (values: ReadValues, key: SettingsKey): string | undefined => {
  const value = values.get(key)?.value;
  return typeof value === "string" ? value : undefined;
};
const providerOf = (values: ReadValues, key: SettingsKey): ProviderKind | undefined => {
  const parsed = SettingsValues.shape["providers.default"].safeParse(values.get(key)?.value);
  return parsed.success ? parsed.data : undefined;
};
const notOnMachine = "That model isn't on this machine.";

/** A model the catalog lists for `provider` under `id`, on `account` when it has one there. */
function option(
  agents: NewThreadAgents,
  provider: string,
  id: string,
  account?: string,
): ModelOption | undefined {
  const own = agents.models.filter((entry) => entry.provider === provider && entry.id === id);
  return own.find((entry) => entry.account === account) ?? own[0];
}
function pickedOption(agents: NewThreadAgents, pick: ModelPick): ModelOption | undefined {
  const serving = agents.models.filter((entry) => entry.key === pick.key);
  return serving.find((entry) => entry.account === pick.account) ?? serving[0];
}

// Default provider

export function defaultProviderRow(context: AgentsContext): PageRow {
  const entry = context.values.get("providers.default");
  const chosen =
    entry && entry.provenance !== "defaults"
      ? providerOf(context.values, "providers.default")
      : undefined;
  const providers = context.agents.providers;
  const value = chosen ?? startingProvider({ chosen, lastUsed: undefined, providers });
  const choices = defaultProviderChoices(context);
  if (value && !choices.some((choice) => choice.id === value))
    choices.unshift({
      id: value,
      label: providerChoiceLabel({ name: providerNames[value], state: "not_installed" }),
    });
  return {
    id: "providers.default",
    key: "providers.default",
    title: agentSettingTitles["providers.default"],
    control: { kind: "choice", style: "menu", choices },
    value: value ?? null,
    note: null,
    source: pageSource(entry),
    locked: lockedReason(entry),
    empty: value ? null : "No provider CLI installed",
  };
}
function defaultProviderChoices(context: AgentsContext): PageChoice[] {
  const choices: PageChoice[] = [];
  for (const row of context.agents.providers)
    if (row.installed && !choices.some((choice) => choice.id === row.provider))
      choices.push({
        id: row.provider,
        label: providerChoiceLabel({ name: row.name, state: row.state }),
      });
  return choices;
}
export function defaultProviderWrite(context: AgentsContext, value: unknown): Writes {
  const installed = defaultProviderChoices(context).some((choice) => choice.id === value);
  if (typeof value !== "string" || !installed)
    return { ok: false, message: "That provider isn't installed on this machine." };
  return { ok: true, writes: [["providers.default", value]] };
}

// Roles

interface RoleState {
  provider: ProviderKind | undefined;
  model: string | undefined;
  effort: string;
  tier: string;
  found: ModelOption | undefined;
}
function roleState(context: AgentsContext, role: Role): RoleState {
  const keys = roleKeys(role);
  const provider = providerOf(context.values, keys.provider);
  const raw = text(context.values, keys.model);
  const model = raw && raw !== "default" ? raw : undefined;
  return {
    provider,
    model,
    effort: text(context.values, keys.effort) ?? "default",
    tier: text(context.values, keys.tier) ?? "default",
    found: provider && model ? option(context.agents, provider, model) : undefined,
  };
}
function roleModelLabel(state: RoleState): string {
  if (!state.provider) return "Not set";
  return (
    state.found?.label ?? (state.model ? modelLabel(state.model) : providerNames[state.provider])
  );
}

/** The role's row on the Agents page: its model and effort, opening the role's own page. */
export function roleLinkRow(context: AgentsContext, role: Role): PageRow {
  const state = roleState(context, role);
  const entry = context.values.get(roleKeys(role).provider);
  const parts = [roleModelLabel(state)];
  if (state.provider && state.effort !== "default") parts.push(effortLabel(state.effort));
  return {
    id: `roles.${role}`,
    key: null,
    title: agentSettingTitles[`roles.${role}`],
    control: {
      kind: "link",
      page: `role.${role}`,
      provider: state.provider ?? null,
      label: parts.join(" · "),
    },
    value: null,
    note: null,
    source: pageSource(entry),
    locked: null,
    empty: null,
  };
}

function effortChoices(state: RoleState): PageChoice[] {
  const listed = state.found?.efforts.filter(isEffort);
  const choices: PageChoice[] = listed?.length
    ? [
        { id: "default", label: "Default effort" },
        ...listed.map((id) => ({ id, label: effortLabel(id) })),
      ]
    : roleEffortChoices.map((choice) => ({ id: choice.value, label: choice.label }));
  // An effort saved elsewhere stays visible, so the page never lies.
  if (!choices.some((choice) => choice.id === state.effort))
    choices.push({ id: state.effort, label: effortLabel(state.effort) });
  return choices;
}
function tierChoices(state: RoleState): PageChoice[] {
  const choices: PageChoice[] = [{ id: "default", label: "Default speed" }];
  for (const tier of state.found?.speeds ?? [])
    if (tier.value && isTier(tier.value) && !choices.some((choice) => choice.id === tier.value))
      choices.push({ id: tier.value, label: speedLabel(tier.speed) });
  if (!choices.some((choice) => choice.id === state.tier))
    choices.push({ id: state.tier, label: effortLabel(state.tier) });
  return choices;
}

/** A role's own page: its model, then effort and speed once a model is set. */
export function roleRows(context: AgentsContext, role: Role): PageRow[] {
  const keys = roleKeys(role);
  const state = roleState(context, role);
  const entry = (key: SettingsKey) => context.values.get(key);
  const rows: PageRow[] = [
    {
      id: "role.model",
      key: keys.model,
      title: "Model",
      control: {
        kind: "model",
        picker: "role",
        provider: state.provider ?? null,
        label: roleModelLabel(state),
        account: null,
        clear: "Not set",
        cleared: !state.provider,
      },
      value: state.provider
        ? { key: modelKey(state.provider, state.model ?? ""), account: state.found?.account ?? "" }
        : null,
      note: null,
      source: pageSource(entry(keys.provider)),
      locked: lockedReason(entry(keys.provider)) ?? lockedReason(entry(keys.model)),
      empty: null,
    },
  ];
  if (!state.provider) return rows;
  rows.push({
    id: "role.effort",
    key: keys.effort,
    title: "Effort",
    control: { kind: "choice", style: "menu", choices: effortChoices(state) },
    value: state.effort,
    note: null,
    source: pageSource(entry(keys.effort)),
    locked: lockedReason(entry(keys.effort)),
    empty: null,
  });
  const tiers = tierChoices(state);
  if (tiers.length > 1)
    rows.push({
      id: "role.tier",
      key: keys.tier,
      title: "Speed",
      control: { kind: "choice", style: "menu", choices: tiers },
      value: state.tier,
      note: null,
      source: pageSource(entry(keys.tier)),
      locked: lockedReason(entry(keys.tier)),
      empty: null,
    });
  return rows;
}

/** A change on a role's page: model first, then provider, so a role never has a stale model. */
export function roleWrite(context: AgentsContext, role: Role, row: string, value: unknown): Writes {
  const keys = roleKeys(role);
  const state = roleState(context, role);
  if (row === "role.model") {
    if (value === null)
      return {
        ok: true,
        writes: [
          [keys.provider, null],
          [keys.model, "default"],
          [keys.effort, "default"],
          [keys.tier, "default"],
        ],
      };
    const pick = modelPick(value);
    const found = pick && pickedOption(context.agents, pick);
    if (!found) return { ok: false, message: notOnMachine };
    const writes: [SettingsKey, unknown][] = [
      [keys.model, found.id],
      [keys.provider, found.provider],
    ];
    // What the new model doesn't take goes back to the provider's default.
    if (state.effort !== "default" && !found.efforts.includes(state.effort))
      writes.push([keys.effort, "default"]);
    if (state.tier !== "default" && !found.speeds.some((tier) => tier.value === state.tier))
      writes.push([keys.tier, "default"]);
    return { ok: true, writes };
  }
  if (!state.provider) return { ok: false, message: "Pick a model for this role first." };
  if (row === "role.effort") {
    if (!effortChoices(state).some((choice) => choice.id === value))
      return { ok: false, message: "This model doesn't take that effort on this machine." };
    return { ok: true, writes: [[keys.effort, value]] };
  }
  if (row === "role.tier") {
    if (!tierChoices(state).some((choice) => choice.id === value))
      return { ok: false, message: "This model doesn't run at that speed on this machine." };
    return { ok: true, writes: [[keys.tier, value]] };
  }
  return { ok: false, message: "This setting isn't on this page." };
}

export function modelPick(value: unknown): ModelPick | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const key = Reflect.get(value, "key");
  const account = Reflect.get(value, "account");
  return typeof key === "string" && typeof account === "string" ? { key, account } : undefined;
}

// Utility model

/** The agents a short generation can run on: ACP agents have no one-shot mode. */
const allowed = (provider: ProviderKind) => utilityProviders.includes(provider);
export function utilityAgents(agents: NewThreadAgents): NewThreadAgents {
  return {
    providers: agents.providers.filter((row) => allowed(row.provider)),
    models: agents.models.filter((row) => allowed(row.provider)),
    accounts: agents.accounts.filter((row) => allowed(row.provider)),
    picker: {
      ...agents.picker,
      models: agents.picker.models.filter((row) => allowed(row.provider)),
      providers: agents.picker.providers.filter((row) => allowed(row.provider)),
    },
  };
}

export function utilityRow(context: AgentsContext): PageRow {
  const entry = context.values.get("generation.model");
  const parsed = UtilityModelChoice.nullable().safeParse(entry?.value ?? null);
  const choice = parsed.success ? parsed.data : null;
  const ready = context.agents.providers.filter((row) => row.ready).map((row) => row.provider);
  const resolved = resolveUtilityModel({ choice, ready, models: context.catalog.models });
  const shown =
    resolved && option(context.agents, resolved.provider, resolved.model, resolved.instance);
  const name = shown?.label ?? (resolved ? modelLabel(resolved.model) : undefined);
  const label = choice ? (name ?? modelLabel(choice.model)) : name ? `Auto · ${name}` : "Off";
  const provider = choice?.provider ?? resolved?.provider;
  const accounts = context.agents.accounts.filter((account) => account.provider === provider);
  const instance = choice?.instance ?? resolved?.instance;
  const account =
    accounts.length > 1 ? accounts.find((known) => known.id === instance)?.label : undefined;
  return {
    id: "generation.model",
    key: "generation.model",
    title: agentSettingTitles["generation.model"],
    control: {
      kind: "model",
      picker: "utility",
      provider: provider ?? null,
      label,
      account: account ?? null,
      clear: "Auto",
      cleared: !choice,
    },
    value: choice
      ? { key: modelKey(choice.provider, choice.model), account: choice.instance ?? "" }
      : null,
    note: null,
    source: pageSource(entry),
    locked: lockedReason(entry),
    empty: null,
  };
}

export function utilityWrite(context: AgentsContext, value: unknown): Writes {
  if (value === null) return { ok: true, writes: [["generation.model", null]] };
  const pick = modelPick(value);
  const found = pick && pickedOption(utilityAgents(context.agents), pick);
  if (!found) return { ok: false, message: "That model can't write titles on this machine." };
  return {
    ok: true,
    writes: [
      [
        "generation.model",
        {
          provider: found.provider,
          model: found.id,
          ...(found.account ? { instance: found.account } : {}),
        },
      ],
    ],
  };
}
