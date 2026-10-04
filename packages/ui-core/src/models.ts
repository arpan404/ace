import type { Capabilities, CatalogModel, ProviderKind } from "@ace/protocol";
import { blockingReset, tightestWindow, type AccountView } from "./accounts.ts";
import type { ProviderStatus } from "./provider-status.ts";
import { modelLabel, providerNames } from "./providers.ts";

/** One model on one of the person's signed-in accounts, as the composer's picker lists it. */
export interface ModelChoice {
  /** The catalog row id; unique per model and account. */
  id: string;
  provider: ProviderKind;
  /** Display name, "Opus 4.1". */
  model: string;
  /** What thread.create carries as `model`. */
  modelId: string;
  /** The account label, "Personal"; empty when the provider has no accounts. */
  account: string;
  accountId: string;
  /** "62% of 5-hour window used", "Default model", or the provider's own config. */
  note: string;
  /** Share of the tightest window spent, 0..1, when the provider reports it. */
  used: number | undefined;
  /** The account can't take work until its window resets. */
  exhausted: boolean;
  resetsAt: number | undefined;
  isDefault: boolean;
  /** Reasoning efforts the model takes, in the catalog's order; empty when it has no choice. */
  efforts: readonly string[];
  defaultEffort: string | undefined;
}

/**
 * The model a thread runs on, read from the thread's own record when the catalog can't be read
 * (offline, before it loads): its name (or the provider's default), with no account or usage
 * claimed.
 */
export function recordedChoice(
  selection: { provider: ProviderKind; model?: string | undefined } | undefined,
): ModelChoice | undefined {
  if (!selection) return undefined;
  const model = selection.model;
  return {
    id: `recorded:${selection.provider}:${model ?? "default"}`,
    provider: selection.provider,
    // No model on record: the provider runs its own default.
    model: model ? modelLabel(model) : `${providerNames[selection.provider]} default`,
    modelId: model ?? "",
    account: "",
    accountId: "",
    note: "",
    used: undefined,
    exhausted: false,
    resetsAt: undefined,
    isDefault: false,
    efforts: [],
    defaultEffort: undefined,
  };
}

/**
 * An account label as the quiet tag shown beside a model ("Opus 4.1 personal",
 * "Claude Code · work"). The label stays as the provider gave it on the Accounts page.
 */
export function accountTag(label: string): string {
  return label.toLocaleLowerCase();
}

/** Provider, account and model in one line: "Claude Code · work · Sonnet 4.5". */
export function choiceLine(choice: ModelChoice): string {
  const account = choice.account ? ` · ${accountTag(choice.account)}` : "";
  return `${providerNames[choice.provider]}${account} · ${choice.model}`;
}

function note(model: CatalogModel, account: AccountView | undefined): string {
  if (!account) return model.isDefault ? "Default model" : "";
  if (!account.signedIn) return "Signed out";
  const window = tightestWindow(account);
  return window ? `${window.usedPercent}% of ${window.label} window used` : "No usage reported";
}

/**
 * `models.list` joined with `accounts.list`: each visible model under the account (instance)
 * that serves it, grouped by provider in catalog order, signed-out accounts left out.
 */
export function modelChoices(
  models: readonly CatalogModel[],
  accounts: readonly AccountView[],
): ModelChoice[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const providers = [...new Set(models.map((model) => model.provider))];
  return providers.flatMap((provider) =>
    models
      .filter((model) => model.provider === provider && !model.hidden)
      .flatMap((model): ModelChoice[] => {
        const account = byId.get(model.instance);
        if (account && !account.signedIn) return [];
        const window = account && tightestWindow(account);
        const exhausted = account?.availability === "exhausted";
        return [
          {
            id: model.id,
            provider,
            model: model.displayName,
            modelId: model.nativeModelId,
            account: account?.label ?? "",
            accountId: model.instance,
            note: note(model, account),
            used: window ? window.usedPercent / 100 : undefined,
            exhausted,
            resetsAt: exhausted && account ? blockingReset(account) : undefined,
            isDefault: model.isDefault,
            efforts: model.reasoningEfforts,
            defaultEffort: model.defaultEffort,
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
      (selection.model === undefined || choice.modelId === selection.model),
  );
  // Never another provider's model: a thread shows what it runs on, and picking from a wrong
  // choice (an effort change) would move it to that provider. With no catalog choice for its
  // provider, the caller shows the recorded selection (`recordedChoice`).
  return (
    sameModel.find((choice) => choice.accountId === selection.instanceId) ??
    (selection.model === undefined ? sameModel.find((choice) => choice.isDefault) : undefined) ??
    sameModel[0] ??
    defaultModelChoice(
      choices.filter((choice) => choice.provider === selection.provider),
      selection.provider,
    )
  );
}

/** The `thread.switch` selection that moves a thread onto a choice. */
export function choiceSelection(choice: ModelChoice): ThreadSelection & { model: string } {
  return {
    provider: choice.provider,
    model: choice.modelId,
    // Only a signed-in account names an instance; otherwise the daemon picks one.
    ...(choice.account ? { instanceId: choice.accountId } : {}),
  };
}

/** A model to start a thread with; the account is picked separately. */
export interface ModelOption {
  /** `nativeModelId`, which is what thread.create carries. */
  id: string;
  label: string;
  provider: ProviderKind;
  isDefault: boolean;
  /** False for "the provider's default" when the catalog is empty: thread.create sends no model. */
  fromCatalog: boolean;
  /** Reasoning efforts the model takes, in the catalog's order; empty when it has no choice. */
  efforts: readonly string[];
  defaultEffort: string | undefined;
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

/**
 * The New thread pickers: each model once per provider (whichever accounts serve it), and the
 * signed-in accounts, the first with headroom marked as the default for its provider. Only
 * providers discovery found installed are offered; an installed CLI the catalog lists no models
 * for is offered on its own default model, so a daemon without a model catalog still starts
 * threads on whatever the person has installed.
 */
export function newThreadOptions(
  models: readonly CatalogModel[],
  accounts: readonly AccountView[],
  providers: readonly Pick<ProviderStatus, "provider" | "state">[],
): { models: ModelOption[]; accounts: AccountOption[] } {
  const missing = new Set(
    providers.filter((status) => status.state === "not_installed").map((s) => s.provider),
  );
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const model of models) {
    const key = `${model.provider}\u0000${model.nativeModelId}`;
    if (model.hidden || missing.has(model.provider) || seen.has(key)) continue;
    seen.add(key);
    options.push({
      id: model.nativeModelId,
      label: model.displayName,
      provider: model.provider,
      isDefault: model.isDefault,
      fromCatalog: true,
      efforts: model.reasoningEfforts,
      defaultEffort: model.defaultEffort,
    });
  }
  const listed = new Set(options.map((option) => option.provider));
  // An ACP agent needs its identity to start, which only the catalog carries.
  for (const { provider, state } of providers)
    if (state !== "not_installed" && provider !== "acp" && !listed.has(provider)) {
      listed.add(provider);
      options.push({
        id: `${provider}:default`,
        label: `${providerNames[provider]} default`,
        provider,
        isDefault: true,
        fromCatalog: false,
        efforts: [],
        defaultEffort: undefined,
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
