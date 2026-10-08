import type { ProviderKind } from "@ace/protocol";
import { catalogSignal, type CatalogSignal } from "@ace/ui-core";
import { useModelCatalog, useModelInstances } from "@/lib/model-catalog.ts";

/**
 * What the model catalog says about each provider (whether it lists models, and an expired
 * sign-in), for `readinessView`; undefined for every provider until the catalog has loaded.
 * Kept apart from `provider-readiness.ts` so readiness alone never loads the catalog.
 */
export function useCatalogSignals(): (
  provider: ProviderKind,
  instance?: string,
) => CatalogSignal | undefined {
  const models = useModelCatalog();
  const instances = useModelInstances();
  return (provider, instance) =>
    models ? catalogSignal(models, instances, provider, instance) : undefined;
}
