import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import {
  resolveEffort,
  selectNewThreadModel,
  speedOrder,
  type Speed,
  type AccountOption,
  type ModelOption,
} from "@ace/ui-core";
import type { ProviderKind } from "@ace/protocol";

export interface NewThreadOptions {
  models: readonly ModelOption[];
  accounts: readonly AccountOption[];
}

export const WorkMode = z.enum(["worktree", "local"]);
export type WorkMode = z.infer<typeof WorkMode>;

/** What the next thread starts with. The last choices are remembered on this device. */
export const Choices = z.object({
  project: z.string().min(1).optional().catch(undefined),
  /** The picked model option's `key`. */
  model: z.string().min(1).optional().catch(undefined),
  account: z.string().min(1).optional().catch(undefined),
  mode: WorkMode.optional().catch(undefined),
  effort: z.string().min(1).optional().catch(undefined),
  /** The model's service speed, where it offers more than one. */
  speed: z.enum(speedOrder).optional().catch(undefined),
});
export type Choices = z.infer<typeof Choices>;

const storageKey = "ace.home.newThread";
export const loadChoices = (storage: KeyValueStorage | undefined): Choices =>
  readJson(storage, storageKey, Choices, {});
export const saveChoices = (storage: KeyValueStorage | undefined, choices: Choices) =>
  writeJson(storage, storageKey, choices);

export interface Resolved {
  /** The provider the thread starts on; undefined until the catalog lists a model. */
  provider: ProviderKind | undefined;
  /** The account's model; undefined when the catalog lists none for it. */
  model: ModelOption | undefined;
  /** The option key to save in place of a legacy bare model id the choice matched. */
  upgradedModel?: string | undefined;
  account: AccountOption | undefined;
  mode: WorkMode;
  /** One of the model's efforts: the chosen one, else the model's default. */
  effort: string | undefined;
  /** One of the model's speeds: as chosen, else as the catalog runs it by default. */
  speed: Speed;
}

/**
 * The provider (the one picked on this visit, else the starting provider, else any the catalog
 * lists), then an account of it, then that account's model: the remembered model when the
 * account serves it, else the account's own default. Another account's default never decides.
 */
export function resolve(
  options: NewThreadOptions | undefined,
  choices: Choices,
  provider: ProviderKind | undefined,
  defaultMode: WorkMode = "worktree",
): Resolved {
  const models = options?.models ?? [];
  const chosen =
    provider !== undefined && models.some((m) => m.provider === provider)
      ? provider
      : (models.find((m) => m.isDefault) ?? models[0])?.provider;
  const own = models.filter((m) => m.provider === chosen);
  const saved = own.find((m) => m.key === choices.model);
  // Choices saved before option keys hold a bare id. Providers share ids, so only the selected
  // provider's options may claim one.
  const legacy =
    saved || provider === undefined || choices.model === undefined
      ? undefined
      : own.find((m) => m.id === choices.model);
  const { account, model } =
    chosen === undefined
      ? { account: undefined, model: undefined }
      : selectNewThreadModel({
          models,
          accounts: options?.accounts ?? [],
          provider: chosen,
          model: (saved ?? legacy)?.key,
          account: choices.account,
        });
  const efforts = model?.efforts ?? [];
  const effort = resolveEffort(efforts, choices.effort, model?.defaultEffort);
  return {
    provider: chosen,
    model,
    account,
    mode: choices.mode ?? defaultMode,
    effort,
    speed: !model
      ? "standard"
      : model.speeds.some((tier) => tier.speed === choices.speed)
        ? (choices.speed ?? model.defaultSpeed)
        : model.defaultSpeed,
    ...(legacy ? { upgradedModel: legacy.key } : {}),
  };
}

/**
 * Explicit request, then the project Home is narrowed to, then the remembered project, then the
 * first one. ⌘N and the sidebar's New thread row both come here without a request.
 */
export function pickProject(
  projects: readonly string[],
  requested: string | undefined,
  remembered: string | undefined,
  filter: string | null,
): string | undefined {
  for (const candidate of [requested, filter ?? undefined, remembered])
    if (candidate && projects.includes(candidate)) return candidate;
  return requested ?? projects[0];
}

/** Fill only settings that were unresolved when a preparation was first saved. */
export function completePreparationChoices(saved: Choices, resolved: Resolved): Choices {
  return {
    ...saved,
    model: resolved.upgradedModel ?? saved.model ?? resolved.model?.key,
    account: saved.account ?? resolved.account?.id,
    effort: saved.effort ?? resolved.effort,
    speed: saved.speed ?? (resolved.model ? resolved.speed : undefined),
    mode: saved.mode ?? resolved.mode,
  };
}

/** Before discovery, last-used global choices are hints. Pin the settings actually shown. */
export function shownPreparationChoices(saved: Choices, resolved: Resolved): Choices {
  return completePreparationChoices(
    {
      ...saved,
      model: resolved.model?.key ?? saved.model,
      account: resolved.account?.id ?? saved.account,
      effort: resolved.effort ?? saved.effort,
      speed: resolved.model ? resolved.speed : saved.speed,
    },
    resolved,
  );
}
