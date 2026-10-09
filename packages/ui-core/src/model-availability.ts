import { isDefaultSelection, matchesModel } from "@ace/models/resolve";
import { modelDisplayName } from "@ace/models/display-name";
import type { CatalogModel, ExecutionSelection } from "@ace/protocol";
import type { PickerModel } from "./model-picker.ts";
import { providerNames } from "./providers.ts";

/** An explicit selection stays visible when discovery no longer offers its route. */
export function unavailableSelection(
  models: readonly CatalogModel[] | undefined,
  selection: Pick<ExecutionSelection, "provider" | "model" | "instanceId"> | undefined,
) {
  if (!models || !selection?.model || isDefaultSelection(selection.model)) return undefined;
  const serving = servingModels(models, selection);
  const matching = serving.filter((model) => matchesModel(model, selection.model ?? ""));
  if (matching.length && new Set(matching.map((model) => model.id)).size === 1) return undefined;
  return {
    provider: selection.provider,
    model: selection.model,
    label: modelDisplayName(selection.model).displayName,
    instance: selection.instanceId,
    replacement: modelReplacement(models, selection),
  };
}

function servingModels(
  models: readonly CatalogModel[],
  selection: Pick<ExecutionSelection, "provider" | "model" | "instanceId">,
) {
  return models.filter(
    (model) =>
      model.provider === selection.provider &&
      (!selection.instanceId ||
        model.instance === selection.instanceId ||
        model.instanceId === selection.instanceId),
  );
}

/** The same account's recommended current model, excluding the rejected selection. */
export function modelReplacement(
  models: readonly CatalogModel[] | undefined,
  selection: Pick<ExecutionSelection, "provider" | "model" | "instanceId">,
) {
  const eligible = servingModels(models ?? [], selection).filter(
    (model) =>
      !model.hidden &&
      !model.deprecated &&
      !model.legacy &&
      model.tier !== "legacy" &&
      !matchesModel(model, selection.model ?? "") &&
      modelDisplayName(model.id).displayName !==
        modelDisplayName(selection.model ?? "").displayName,
  );
  return eligible.find((model) => model.isDefault) ?? eligible[0];
}

export function unavailableModelNotice(selection: {
  provider: ExecutionSelection["provider"];
  model: string;
}) {
  return `${modelDisplayName(selection.model).displayName} isn't available in ${providerNames[selection.provider]} anymore — pick another model`;
}

/** A disabled selected row, kept apart from runnable choices. */
export function unavailablePickerModel(selection: {
  provider: ExecutionSelection["provider"];
  model: string;
  instanceId?: string | undefined;
}): PickerModel {
  return {
    key: `${selection.provider}\u0000${selection.model}`,
    provider: selection.provider,
    label: modelDisplayName(selection.model).displayName,
    instance: selection.instanceId,
    isNew: false,
    legacy: false,
    isDefault: false,
    unavailable: "Unavailable",
  };
}
