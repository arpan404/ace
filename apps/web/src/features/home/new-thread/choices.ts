import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { AccountOption, ModelOption } from "@ace/ui-core";
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
});
export type Choices = z.infer<typeof Choices>;

const storageKey = "ace.home.newThread";
export const loadChoices = (storage: KeyValueStorage | undefined): Choices =>
  readJson(storage, storageKey, Choices, {});
export const saveChoices = (storage: KeyValueStorage | undefined, choices: Choices) =>
  writeJson(storage, storageKey, choices);

export interface Resolved {
  model: ModelOption | undefined;
  account: AccountOption | undefined;
  mode: WorkMode;
  /** One of the model's efforts: the chosen one, else the model's default. */
  effort: string | undefined;
}

/**
 * The model on `provider` (the one picked on this visit, else the starting provider): the
 * remembered model when it is one of that provider's, else the provider's default; any default
 * when the provider has no models. Then an account for the model's provider.
 */
export function resolve(
  options: NewThreadOptions | undefined,
  choices: Choices,
  provider: ProviderKind | undefined,
): Resolved {
  const models = options?.models ?? [];
  const own = provider === undefined ? models : models.filter((m) => m.provider === provider);
  const model =
    own.find((m) => m.key === choices.model) ??
    own.find((m) => m.isDefault) ??
    own[0] ??
    models.find((m) => m.isDefault) ??
    models[0];
  const forProvider = options?.accounts.filter((a) => a.provider === model?.provider) ?? [];
  const account =
    forProvider.find((a) => a.id === choices.account) ??
    forProvider.find((a) => a.isDefault) ??
    forProvider[0];
  const efforts = model?.efforts ?? [];
  const effort =
    choices.effort && efforts.includes(choices.effort)
      ? choices.effort
      : model?.defaultEffort && efforts.includes(model.defaultEffort)
        ? model.defaultEffort
        : undefined;
  return { model, account, mode: choices.mode ?? "worktree", effort };
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
