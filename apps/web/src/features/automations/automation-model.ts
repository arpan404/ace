import {
  choicesFromModel as choicesFromStored,
  type AutomationModelFields,
} from "@ace/ui-core/automations";
import type { ModelChoices, NewThreadOptions, ResolvedModel } from "@/features/home/index.ts";

/*
 * An automation's model as the composer's model chip shows it, and back. The chip works in
 * catalog option keys and accounts; an automation stores the provider, the catalog model id, the
 * account instance and the effort. Pure.
 */

type ModelFields = AutomationModelFields;

/** The chip's choices for a stored model: its catalog row on that account, else on any. */
export function choicesFromModel(
  fields: ModelFields,
  options: NewThreadOptions | undefined,
): ModelChoices {
  return choicesFromStored(fields, options?.models);
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
