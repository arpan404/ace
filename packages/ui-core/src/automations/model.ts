import type { Automation } from "@ace/protocol";

/*
 * An automation's model as a model picker shows it, and copies of an automation. The picker works
 * in catalog option keys and accounts; an automation stores the provider, the catalog model id,
 * the account instance and the effort. Pure.
 */

export type AutomationModelFields = Pick<Automation, "provider" | "model" | "effort" | "instance">;

/** A catalog row as pickers list it: the model id it runs and the key it is picked by. */
export interface PickerModelOption {
  provider: string;
  id: string;
  key: string;
  account?: string | undefined;
}

/** What a picker holds: the option key, the account and the effort. */
export interface AutomationModelChoice {
  model?: string;
  account?: string;
  effort?: string;
}

/** The picker's choices for a stored model: its catalog row on that account, else on any. */
export function choicesFromModel(
  fields: AutomationModelFields,
  models: readonly PickerModelOption[] | undefined,
): AutomationModelChoice {
  const own = (models ?? []).filter((option) => option.provider === fields.provider);
  const matches = (id: string | undefined) =>
    own.filter((option) => id !== undefined && (option.id === id || option.key === id));
  // Older definitions stored a picker row id ("account:model").
  const rows = matches(fields.model).length
    ? matches(fields.model)
    : matches(fields.model?.split(":").at(-1));
  const row = rows.find((option) => option.account === fields.instance) ?? rows[0];
  return {
    ...(row ? { model: row.key } : {}),
    ...(fields.instance ? { account: fields.instance } : {}),
    ...(fields.effort ? { effort: fields.effort } : {}),
  };
}

/**
 * A copy of an automation under a new id: named "<title> copy" and paused, so it never fires
 * twice before the person changes what it watches.
 */
export function duplicateAutomation(automation: Automation, id: string): Automation {
  return {
    ...automation,
    id,
    title: `${automation.title.slice(0, 251)} copy`,
    enabled: false,
  };
}
