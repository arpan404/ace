import type { CatalogModel, ModelSourceStatus } from "@ace/protocol";
import type { CacheEntry } from "./types.ts";

export function refreshedSources(
  models: readonly CatalogModel[],
  sources: readonly ModelSourceStatus[] | undefined,
  previous: CacheEntry | undefined,
  now: number,
) {
  const failed = new Set(
    sources?.filter((source) => source.error).map((source) => source.source.id),
  );
  const retained =
    previous?.models.filter((model) =>
      failed.has(model.source?.id ?? model.nativeProviderId ?? model.instance),
    ) ?? [];
  const statuses: readonly ModelSourceStatus[] =
    sources ??
    [
      ...new Map(
        models.filter((model) => model.source).map((model) => [model.source?.id, model.source]),
      ).values(),
    ].flatMap((source) => (source ? [{ source, status: "fresh" as const }] : []));
  return {
    models: [...models, ...retained],
    // oxlint-disable-next-line oxc/no-map-spread -- Clone immutable cached values for this view.
    sources: statuses.map((status) => ({
      ...status,
      lastRefreshedAt: status.error
        ? (status.lastRefreshedAt ??
          previous?.sources?.find((old) => old.source.id === status.source.id)?.lastRefreshedAt ??
          previous?.refreshedAt)
        : now,
    })),
  };
}
