import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import {
  resolveEffort,
  selectNewThreadModel,
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
  /** Run on the model's faster tier, where it has one. */
  fast: z.boolean().optional().catch(undefined),
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
  /** On the model's faster tier: as chosen, else as the catalog runs it by default. */
  fast: boolean;
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
    fast: model?.fastTier !== undefined && (choices.fast ?? model.fastDefault),
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
