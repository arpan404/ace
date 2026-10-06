import type { ModelScope } from "@ace/client";
import type { Capabilities, CatalogModel, ProviderKind } from "@ace/protocol";
import { tightestWindow, type AccountView } from "./accounts.ts";
import { accountLimit } from "./limits.ts";
import type { ProviderStatus } from "./provider-status.ts";
import { modelLine, modelName } from "./model-label.ts";
import { modelLabel, providerNames } from "./providers.ts";

/** One model on one of the person's signed-in accounts, as the composer's picker lists it. */
export interface ModelChoice {
  /** The row on one account: `instance:catalog id`. Catalog ids repeat across accounts. */
  id: string;
  provider: ProviderKind;
  /** Display name, "Opus 4.1". */
  model: string;
  /** The catalog id (OpenCode's `provider/model`), which commands carry as `model`. */
  modelId: string;
  /** Other ids a thread's record may name this model by: native, resolved and alias ids. */
  aliases: readonly string[];
  /** The account label, "Personal"; empty when the provider has no accounts. */
  account: string;
  accountId: string;
  /** "62% of 5-hour window used", or nothing when the provider has no accounts. */
  note: string;
  /** Share of the tightest window spent, 0..1, when the provider reports it. */
  used: number | undefined;
  /** The account can't take work until its window resets. */
  exhausted: boolean;
  resetsAt: number | undefined;
  /** This account's default model; another account may default to another one. */
  isDefault: boolean;
  /** Reasoning efforts the model takes, in the catalog's order; empty when it has no choice. */
  efforts: readonly string[];
  defaultEffort: string | undefined;
  /** The model's identity across accounts (`modelKey`), which favorites and the picker use. */
  key: string;
  /** The provider marks it newly released. */
  isNew: boolean;
  /** Deprecated by the provider: listed under Legacy models. */
  legacy: boolean;
  /** The `serviceTier` that runs it faster, when it has one ace can ask for. */
  fastTier: string | undefined;
  /** The catalog runs it on that faster tier unless asked otherwise (`defaultTier`). */
  fastDefault: boolean;
}

/**
 * A model's identity in pickers and favorites: its provider and catalog id. Providers share
 * ids (Codex, Pi and Cursor all list `gpt-5.5`), so the id alone never identifies one.
 */
export function modelKey(provider: ProviderKind, id: string): string {
  return `${provider}\u0000${id}`;
}

/**
 * The service tier that makes a model faster, when the catalog names it as a `serviceTier`
 * launch option (Codex's priority tier). Tiers set some other way (a Claude fast-mode flag) are
 * not something a thread can be started or switched with, so they don't count.
 */
export function fastTier(model: Pick<CatalogModel, "serviceTiers">): string | undefined {
  return fastTierEntry(model)?.value;
}

function fastTierEntry(model: Pick<CatalogModel, "serviceTiers">) {
  for (const tier of model.serviceTiers) {
    const value = tier.parameters["serviceTier"];
    if (tier.speed === "fast" && typeof value === "string") return { id: tier.id, value };
  }
  return undefined;
}

/** The catalog's default tier is the faster one: speed is on until the person turns it off. */
export function fastByDefault(model: Pick<CatalogModel, "serviceTiers" | "defaultTier">): boolean {
  const tier = fastTierEntry(model);
  return tier !== undefined && model.defaultTier === tier.id;
}

/**
 * The model a thread runs on, read from the thread's own record when the catalog can't be read
 * (offline, before it loads): its name, with no account or usage claimed. A record without a
 * model says so rather than naming a default the provider may not run.
 */
export function recordedChoice(
  selection: { provider: ProviderKind; model?: string | undefined } | undefined,
): ModelChoice | undefined {
  if (!selection) return undefined;
  const model = selection.model;
  return {
    id: `recorded:${selection.provider}:${model ?? ""}`,
    provider: selection.provider,
    model: model ? modelLabel(model) : unreportedModel,
    modelId: model ?? "",
    aliases: [],
    account: "",
    accountId: "",
    note: "",
    used: undefined,
    exhausted: false,
    resetsAt: undefined,
    isDefault: false,
    efforts: [],
    defaultEffort: undefined,
    key: modelKey(selection.provider, model ?? ""),
    isNew: false,
    legacy: false,
    fastTier: undefined,
    fastDefault: false,
  };
}

/** What a thread's model reads as when neither the catalog nor its record names one. */
export const unreportedModel = "Unknown model";

/**
 * An account label as the quiet tag shown beside a model ("Opus 4.1 personal",
 * "Claude Code · work"). The label stays as the provider gave it on the Accounts page.
 */
export function accountTag(label: string): string {
  return label.toLocaleLowerCase();
}

/** Provider, account and model in one line: "Claude Code · work · Sonnet 4.5". */
export function choiceLine(choice: ModelChoice): string {
  return modelLine(choice.provider, choice.model, choice.account && accountTag(choice.account));
}

function note(account: AccountView | undefined): string {
  if (!account) return "";
  if (!account.signedIn)
    return account.quota.auth === "logged_out" ? "Signed out" : "Sign-in unknown";
  const window = tightestWindow(account);
  return window ? `${window.usedPercent}% of ${window.label} window used` : "No usage reported";
}

/** One catalog row: the account (instance) serving it and its catalog id. */
function rowId(model: Pick<CatalogModel, "instance" | "id">): string {
  return `${model.instance}:${model.id}`;
}

/** Ids other than the catalog id that name the row: native, resolved and alias ids. */
function modelAliases(model: CatalogModel): string[] {
  const ids = [model.nativeModelId, model.resolvedModelId, ...(model.aliases ?? [])];
  return [...new Set(ids.filter((id): id is string => id !== undefined && id !== model.id))];
}

/** A thread's record names the model by its catalog id or by one of its other ids. */
function names(choice: Pick<ModelChoice, "modelId" | "aliases">, model: string): boolean {
  return choice.modelId === model || choice.aliases.includes(model);
}

/**
 * What the catalog says a thread's model reads (its input modalities: "text", "image"…), by the
 * same ids a choice is matched by; undefined when the selection names no model the catalog lists.
 */
export function selectionInputs(
  models: readonly CatalogModel[],
  selection: { provider: ProviderKind; model?: string | undefined } | undefined,
): readonly string[] | undefined {
  const named = selection?.model;
  if (!named) return undefined;
  return models.find(
    (model) =>
      model.provider === selection.provider &&
      (model.id === named || modelAliases(model).includes(named)),
  )?.inputModalities;
}

/**
 * `models.list` joined with `accounts.list`: each visible model under the account (instance)
 * that serves it, grouped by provider in catalog order, signed-out accounts left out, each
 * account's limit as it stands at `now`.
 */
export function modelChoices(
  models: readonly CatalogModel[],
  accounts: readonly AccountView[],
  now: number,
): ModelChoice[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const providers = [...new Set(models.map((model) => model.provider))];
  return providers.flatMap((provider) =>
    models
      .filter((model) => model.provider === provider && !model.hidden)
      .flatMap((model): ModelChoice[] => {
        const account = byId.get(model.instance);
        if (account?.quota.auth === "logged_out") return [];
        const window = account && tightestWindow(account);
        const limit = account && accountLimit(account, now);
        const exhausted = limit?.level === "reached";
        return [
          {
            id: rowId(model),
            provider,
            model: modelName(provider, model.displayName),
            modelId: model.id,
            aliases: modelAliases(model),
            account: account?.label ?? "",
            accountId: model.instance,
            note: note(account),
            used: window ? window.usedPercent / 100 : undefined,
            exhausted,
            resetsAt: limit?.resetsAt,
            isDefault: model.isDefault,
            efforts: model.reasoningEfforts,
            defaultEffort: model.defaultEffort,
            key: modelKey(provider, model.id),
            isNew: model.isNew ?? false,
            legacy: model.deprecated || model.legacy === true,
            fastTier: fastTier(model),
            fastDefault: fastByDefault(model),
          },
        ];
      }),
  );
}

/** What a thread starts with until the person picks: the provider's default, else any usable. */
export function defaultModelChoice(
  choices: readonly ModelChoice[],
  provider: ProviderKind | undefined,
): ModelChoice | undefined {
  const usable = choices.filter((choice) => !choice.exhausted);
  return (
    usable.find((choice) => choice.provider === provider && choice.isDefault) ??
    usable.find((choice) => choice.provider === provider) ??
    usable.find((choice) => choice.isDefault) ??
    usable[0]
  );
}

/** What a thread runs on, as the daemon reports it: an execution selection or its live fields. */
export interface ThreadSelection {
  provider: ProviderKind;
  model?: string | undefined;
  instanceId?: string | undefined;
}

/**
 * The picker's current choice for a thread: the switch waiting for the next turn, else what it
 * runs on now, matched by provider, model and account; the provider's default when the catalog
 * has no exact match.
 */
export function currentModelChoice(
  choices: readonly ModelChoice[],
  selection: ThreadSelection | undefined,
): ModelChoice | undefined {
  if (!selection) return defaultModelChoice(choices, undefined);
  const sameModel = choices.filter(
    (choice) =>
      choice.provider === selection.provider &&
      (selection.model === undefined || names(choice, selection.model)),
  );
  // Never another provider's model: a thread shows what it runs on, and picking from a wrong
  // choice (an effort change) would move it to that provider. With no catalog choice for its
  // provider, the caller shows the recorded selection (`recordedChoice`).
  const onAccount = sameModel.filter((choice) => choice.accountId === selection.instanceId);
  return (
    (selection.model === undefined ? onAccount.find((choice) => choice.isDefault) : undefined) ??
    onAccount[0] ??
    (selection.model === undefined ? sameModel.find((choice) => choice.isDefault) : undefined) ??
    sameModel[0] ??
    defaultModelChoice(
      choices.filter((choice) => choice.provider === selection.provider),
      selection.provider,
    )
  );
}

/** The `thread.switch` selection that moves a thread onto a choice, by its catalog id. */
export function choiceSelection(choice: ModelChoice): ThreadSelection & { model: string } {
  return {
    provider: choice.provider,
    model: choice.modelId,
    // Only a signed-in account names an instance; otherwise the daemon picks one.
    ...(choice.account ? { instanceId: choice.accountId } : {}),
  };
}

/**
 * A model on one account, to start a thread with. Accounts keep their own rows: each has its own
 * default and capabilities, so New thread picks the account first and then its model.
 */
export interface ModelOption {
  /**
   * The model's identity across accounts (`modelKey`). Providers share ids (Codex, Pi and Cursor
   * all list `gpt-5.5`), so picking by `id` alone would land on another provider's model.
   */
  key: string;
  /** The catalog id (OpenCode's `provider/model`), which thread.create carries. */
  id: string;
  /** The account (catalog instance) serving this row. */
  account: string;
  /** What `ModelClient` lists and resolves this row's account by. */
  scope: ModelScope;
  label: string;
  provider: ProviderKind;
  /** This account's default model. */
  isDefault: boolean;
  /** Reasoning efforts the model takes, in the catalog's order; empty when it has no choice. */
  efforts: readonly string[];
  defaultEffort: string | undefined;
  /** The provider marks it newly released. */
  isNew: boolean;
  /** Deprecated by the provider: listed under Legacy models. */
  legacy: boolean;
  /** The `serviceTier` that runs it faster, when it has one ace can ask for. */
  fastTier: string | undefined;
  /** The catalog runs it on that faster tier unless asked otherwise (`defaultTier`). */
  fastDefault: boolean;
}

/** A signed-in account of the chosen model's provider, with how much quota it has used. */
export interface AccountOption {
  id: string;
  provider: ProviderKind;
  label: string;
  /** "38% of 5-hour used", or "no usage reported". */
  usage: string;
  /** The first account with headroom for its provider. */
  isDefault: boolean;
}

/** The account scope a row is listed and resolved under; ACP rows need their source identity. */
export function modelScope(model: CatalogModel): ModelScope | undefined {
  if (model.provider !== "acp") return { provider: model.provider, instance: model.instance };
  const { acpAgentId, installationId, instanceId } = model;
  return acpAgentId && installationId && instanceId
    ? { provider: "acp", acpAgentId, installationId, instanceId }
    : undefined;
}

/**
 * The New thread pickers: every visible model on every account that serves it, and the
 * signed-in accounts, the first with headroom marked as the default for its provider. Only
 * providers discovery found installed are offered. A provider whose catalog lists no models
 * offers none: no stand-in "default" model is made up for it.
 */
export function newThreadOptions(
  models: readonly CatalogModel[],
  accounts: readonly AccountView[],
  providers: readonly Pick<ProviderStatus, "provider" | "state">[],
): { models: ModelOption[]; accounts: AccountOption[] } {
  const missing = new Set(
    providers.filter((status) => status.state === "not_installed").map((s) => s.provider),
  );
  const options: ModelOption[] = [];
  for (const model of models) {
    // An ACP agent needs its identity to start, which only its catalog rows carry.
    const scope = modelScope(model);
    if (model.hidden || missing.has(model.provider) || !scope) continue;
    options.push({
      key: modelKey(model.provider, model.id),
      id: model.id,
      account: model.instance,
      scope,
      label: modelName(model.provider, model.displayName),
      provider: model.provider,
      isDefault: model.isDefault,
      efforts: model.reasoningEfforts,
      defaultEffort: model.defaultEffort,
      isNew: model.isNew ?? false,
      legacy: model.deprecated || model.legacy === true,
      fastTier: fastTier(model),
      fastDefault: fastByDefault(model),
    });
  }
  const signedIn = accounts.filter((account) => account.signedIn);
  const defaults = new Map<ProviderKind, string>();
  for (const account of signedIn)
    if (account.availability !== "exhausted" && !defaults.has(account.provider))
      defaults.set(account.provider, account.id);
  return {
    models: options,
    accounts: signedIn.map((account) => {
      const window = tightestWindow(account);
      return {
        id: account.id,
        provider: account.provider,
        label: account.label,
        usage: window ? `${window.usedPercent}% of ${window.label} used` : "no usage reported",
        isDefault: defaults.get(account.provider) === account.id,
      };
    }),
  };
}

/**
 * The model picker's list for New thread: each model once, whichever accounts serve it. Only
 * what the list shows is shared across accounts; defaults and capabilities stay per account.
 */
export function distinctModelOptions(models: readonly ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.key)) return false;
    seen.add(model.key);
    return true;
  });
}

/** What New thread starts with: an account of the provider, then that account's model. */
export interface NewThreadSelection {
  account: AccountOption | undefined;
  /** Undefined when the account's catalog lists no models. */
  model: ModelOption | undefined;
}

/**
 * The account first, then its model. The account is the remembered one, else one serving the
 * wanted model (the default account first), else the default account. The model is the wanted
 * one on that account, else the account's own default, else its first current model. One
 * account's default never decides another's.
 */
export function selectNewThreadModel(input: {
  models: readonly ModelOption[];
  accounts: readonly AccountOption[];
  provider: ProviderKind;
  /** A model key the person picked; undefined to use the account's default. */
  model: string | undefined;
  account: string | undefined;
}): NewThreadSelection {
  const own = input.models.filter((model) => model.provider === input.provider);
  const wanted = input.model;
  const serves = (account: string, key = wanted) =>
    own.some((model) => model.account === account && (key === undefined || model.key === key));
  const accounts = input.accounts.filter((account) => account.provider === input.provider);
  const remembered = accounts.find((account) => account.id === input.account);
  const account =
    remembered ??
    accounts.find((option) => option.isDefault && serves(option.id)) ??
    accounts.find((option) => serves(option.id)) ??
    accounts.find((option) => option.isDefault && serves(option.id, undefined)) ??
    accounts.find((option) => serves(option.id, undefined)) ??
    accounts.find((option) => option.isDefault) ??
    accounts[0];
  // Without signed-in accounts (no account service), the rows' own instance is the account.
  const anchor = account
    ? undefined
    : (own.find((model) => model.key === wanted) ?? own.find((model) => model.isDefault) ?? own[0]);
  const instance = account?.id ?? anchor?.account;
  const rows = own.filter((model) => model.account === instance);
  const model =
    (wanted === undefined ? undefined : rows.find((row) => row.key === wanted)) ??
    rows.find((row) => row.isDefault && !row.legacy) ??
    rows.find((row) => !row.legacy) ??
    rows[0];
  return { account, model };
}

/** The effort an execution's options name, when they name one. */
export function optionEffort(
  options: Readonly<Record<string, unknown>> | null | undefined,
): string | undefined {
  const effort = options?.["effort"];
  return typeof effort === "string" ? effort : undefined;
}

const effortNames: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** An effort level as people read it: "high" → "High", "xhigh" → "Extra high". */
export function effortLabel(effort: string): string {
  const known = effortNames[effort];
  if (known) return known;
  const words = effort.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A thread's effort selector: the levels on offer and the current one, or why it can't change. */
export interface EffortControl {
  efforts: readonly string[];
  /** What the thread runs at: reported by the daemon, else the model's default, if any. */
  current: string | undefined;
  /** The daemon reported `current`; otherwise it is the provider's default as far as ace knows. */
  reported: boolean;
  /** Set when effort can't be changed on this thread. */
  reason: string | undefined;
}

/**
 * Effort on a thread that already exists changes through a queued switch, which the provider
 * must accept as a session option (`sessionOptions` with an `effort` launch option).
 */
export function threadEffortControl(input: {
  choice: ModelChoice | undefined;
  capabilities: Pick<Capabilities, "sessionOptions" | "launchOptions"> | undefined;
  current: string | undefined;
}): EffortControl {
  const { choice, capabilities } = input;
  const efforts = choice?.efforts ?? [];
  const current = input.current ?? choice?.defaultEffort;
  const reported = input.current !== undefined;
  const blocked = (reason: string): EffortControl => ({ efforts, current, reported, reason });
  if (!choice) return blocked("Choose a model first");
  if (!efforts.length) return blocked(`${choice.model} has no effort levels`);
  if (!capabilities?.sessionOptions || !capabilities.launchOptions?.includes("effort"))
    return blocked(`${providerNames[choice.provider]} sets effort only when a thread starts`);
  return { efforts, current, reported, reason: undefined };
}
