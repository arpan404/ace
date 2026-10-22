import type { Automation } from "@ace/protocol";
import type { ModelChoices, NewThreadOptions, ResolvedModel } from "@/features/home/index.ts";

/*
 * An automation's model as the composer's model chip shows it, and back. The chip works in
 * catalog option keys and accounts; an automation stores the provider, the catalog model id, the
 * account instance and the effort. Pure.
 */

type ModelFields = Pick<Automation, "provider" | "model" | "effort" | "instance">;

/** The chip's choices for a stored model: its catalog row on that account, else on any. */
export function choicesFromModel(
  fields: ModelFields,
  options: NewThreadOptions | undefined,
): ModelChoices {
  const own = (options?.models ?? []).filter((option) => option.provider === fields.provider);
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

/** What the chip shows, stored: undefined until the catalog names a model. */
export function modelFromResolved(resolved: ResolvedModel): ModelFields | undefined {
  const { model, account, effort } = resolved;
  if (!model) return undefined;
  return {
    provider: model.provider,
    model: model.id,
    ...(account ? { instance: account.id } : {}),
    ...(effort && model.efforts.includes(effort) ? { effort } : {}),
  };
}

/** The same automation on another model, effort or account; the rest stays as stored. */
export function withModel(automation: Automation, fields: ModelFields): Automation {
  const { model: _model, effort: _effort, instance: _instance, ...rest } = automation;
  return {
    ...rest,
    provider: fields.provider,
    ...(fields.model ? { model: fields.model } : {}),
    ...(fields.effort ? { effort: fields.effort } : {}),
    ...(fields.instance ? { instance: fields.instance } : {}),
  };
}
