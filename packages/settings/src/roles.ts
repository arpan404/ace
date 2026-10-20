import { SettingsValues, type ProviderKind, type RunRole, type SettingsKey } from "@ace/protocol";

/**
 * Roles: who a `delegate` task with `runRole` runs as. Each role is four settings under one
 * slot (`providers.<slot>.provider`, `.model`, `.tier`, `.reasoningEffort`). Portable: no Node
 * imports, so clients read the same mapping.
 */
export const roleSlots = {
  build: "coder",
  judgment: "planner",
  review: "reviewer",
  verify: "verifier",
} as const satisfies Record<RunRole, string>;
export type RoleSlot = (typeof roleSlots)[RunRole];
/** Roles in the order they are shown and listed. */
export const runRoles = ["build", "judgment", "review", "verify"] as const satisfies RunRole[];

export const roleKeys = (role: RunRole) => {
  const slot = roleSlots[role];
  return {
    provider: `providers.${slot}.provider`,
    model: `providers.${slot}.model`,
    tier: `providers.${slot}.tier`,
    effort: `providers.${slot}.reasoningEffort`,
  } as const satisfies Record<string, SettingsKey>;
};
/** Every role setting, for one read or subscription (16 keys). */
export const roleSettingKeys: SettingsKey[] = runRoles.flatMap((role) =>
  Object.values(roleKeys(role)),
);

/** A set role. `default` model, tier and effort are left out: the provider decides them. */
export interface RoleChoice {
  provider: ProviderKind;
  model?: string;
  effort?: string;
  tier?: Exclude<SettingsValues["providers.coder.tier"], "default">;
}
export type ConfiguredRoles = Partial<Record<RunRole, RoleChoice>>;

/**
 * The roles the person set. A role is set only when its provider is not null, the shipped
 * default; a model, tier or effort without a provider sets nothing.
 */
export function configuredRoles(values: Partial<Record<SettingsKey, unknown>>): ConfiguredRoles {
  const roles: ConfiguredRoles = {};
  for (const role of runRoles) {
    const keys = roleKeys(role);
    const provider = read(values, keys.provider);
    if (!provider) continue;
    const model = read(values, keys.model);
    const effort = read(values, keys.effort);
    const tier = read(values, keys.tier);
    roles[role] = {
      provider,
      ...(model && model !== "default" ? { model } : {}),
      ...(effort && effort !== "default" ? { effort } : {}),
      ...(tier && tier !== "default" ? { tier } : {}),
    };
  }
  return roles;
}

/** A stored value checked against its key's schema; anything else counts as unset. */
function read<K extends SettingsKey>(
  values: Partial<Record<SettingsKey, unknown>>,
  key: K,
): SettingsValues[K] | undefined {
  const parsed = SettingsValues.shape[key].safeParse(values[key]);
  return parsed.success ? (parsed.data as SettingsValues[K]) : undefined;
}
