import type { CatalogModel, ModelInstanceStatus } from "@ace/protocol";

export function modelRequiresAuth(model: Pick<CatalogModel, "free" | "source">): boolean {
  return !model.free && model.source?.kind !== "local" && model.source?.requiresAuth !== false;
}

/** Availability is scoped to the instance; one account's failure cannot block another. */
export function modelsAvailableWithoutAuth(
  models: readonly Pick<CatalogModel, "instance" | "free" | "source">[],
  instances: readonly ModelInstanceStatus[],
): boolean {
  const failing = new Set(
    instances.flatMap((instance) =>
      (instance.sources ?? []).flatMap((entry) =>
        entry.error ? [`${instance.instance}:${entry.source.id}`] : [],
      ),
    ),
  );
  return models.some(
    (model) =>
      !modelRequiresAuth(model) && !failing.has(`${model.instance}:${model.source?.id ?? ""}`),
  );
}
