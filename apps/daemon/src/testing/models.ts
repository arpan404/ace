import { CatalogModel, type ProviderKind } from "@ace/protocol";
import type { DiscoverModels, InstanceInput, ModelCatalog } from "@ace/models";

/** A scripted model's efforts, with Cursor's spelling of xhigh among them. */
export const scriptedEfforts = [
  { id: "low", level: "low", label: "Low" },
  { id: "medium", level: "medium", label: "Medium" },
  { id: "high", level: "high", label: "High" },
  { id: "extra-high", level: "xhigh", label: "Extra high" },
] as const;

/** Model metadata at the scripted CLI boundary; the catalog and persistence remain real. */
export function scriptedModelInstance(
  provider: ProviderKind,
  cwd: string,
  id = `${provider}-cli-default`,
): InstanceInput {
  return { id, provider, cwd, executable: "unused-scripted-cli", loginRevision: "scripted" };
}
export function scriptedModelDiscovery(model = "chosen-model"): DiscoverModels {
  return async (instance) => [
    CatalogModel.parse({
      id: model,
      nativeModelId: model,
      displayName: "Scripted model",
      provider: instance.provider,
      instance: instance.id,
      efforts: scriptedEfforts,
      defaultEffort: "medium",
      serviceTiers: [],
      inputModalities: [],
      isDefault: true,
      hidden: false,
      deprecated: false,
      raw: { json: "{}", truncated: false },
    }),
  ];
}
export async function seedScriptedModels(
  catalog: ModelCatalog,
  instance: InstanceInput,
  model = "chosen-model",
) {
  catalog.registerInstance(instance);
  await catalog.updateFromSession(instance, {
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        name: "Model",
        currentValue: model,
        options: [{ value: model, name: "Scripted model" }],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        type: "select",
        name: "Effort",
        currentValue: "medium",
        options: scriptedEfforts.map((effort) => ({ value: effort.id, name: effort.label })),
      },
    ],
    models: {
      currentModelId: model,
      availableModels: [{ modelId: model, name: "Scripted model" }],
    },
  });
}
