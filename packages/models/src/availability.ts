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

/** Empty inventories are authoritative; transport failures may retain stale choices. */
function emptySources(sources: readonly import("@ace/protocol").ModelSourceStatus[] | undefined) {
  return new Set(
    sources
      ?.filter(
        (entry) => entry.error?.code === "no_models" || entry.error?.code === "not_configured",
      )
      .map((entry) => entry.source.id),
  );
}

export function withoutEmptySourceModels<
  T extends Pick<CatalogModel, "source" | "nativeProviderId">,
>(
  models: readonly T[],
  sources: readonly import("@ace/protocol").ModelSourceStatus[] | undefined,
): T[] {
  const empty = emptySources(sources);
  return models.filter(
    (model) => !empty.has(model.source?.id ?? "") && !empty.has(model.nativeProviderId ?? ""),
  );
}

/** Availability is scoped to each account's connected sources. */
export function withoutEmptySources<
  T extends Pick<CatalogModel, "instance" | "source" | "nativeProviderId">,
>(models: readonly T[], instances: readonly ModelInstanceStatus[]): T[] {
  const empty = new Map(
    instances.map((instance) => [instance.instance, emptySources(instance.sources)]),
  );
  return models.filter(
    (model) =>
      !empty.get(model.instance)?.has(model.source?.id ?? "") &&
      !empty.get(model.instance)?.has(model.nativeProviderId ?? ""),
  );
}
