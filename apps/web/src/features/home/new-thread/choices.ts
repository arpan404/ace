import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { AccountOption, ModelOption } from "@ace/ui-core";

export interface NewThreadOptions {
  models: readonly ModelOption[];
  accounts: readonly AccountOption[];
}

export const WorkMode = z.enum(["worktree", "local"]);
export type WorkMode = z.infer<typeof WorkMode>;

/** What the next thread starts with. The last choices are remembered on this device. */
export const Choices = z.object({
  project: z.string().min(1).optional().catch(undefined),
  model: z.string().min(1).optional().catch(undefined),
  account: z.string().min(1).optional().catch(undefined),
  mode: WorkMode.optional().catch(undefined),
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
}

/** The chosen model if it still exists, else the default; an account for that provider. */
export function resolve(options: NewThreadOptions | undefined, choices: Choices): Resolved {
  const model =
    options?.models.find((m) => m.id === choices.model) ??
    options?.models.find((m) => m.isDefault) ??
    options?.models[0];
  const forProvider = options?.accounts.filter((a) => a.provider === model?.provider) ?? [];
  const account =
    forProvider.find((a) => a.id === choices.account) ??
    forProvider.find((a) => a.isDefault) ??
    forProvider[0];
  return { model, account, mode: choices.mode ?? "worktree" };
}

/** Explicit request, then the remembered project, then the Home filter, then the first one. */
export function pickProject(
  projects: readonly string[],
  requested: string | undefined,
  remembered: string | undefined,
  filter: string | null,
): string | undefined {
  for (const candidate of [requested, remembered, filter ?? undefined])
    if (candidate && projects.includes(candidate)) return candidate;
  return requested ?? projects[0];
}
