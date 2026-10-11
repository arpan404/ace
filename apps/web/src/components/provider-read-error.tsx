import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { IconButton } from "./ui/icon-button.tsx";
import { catalogKey, useCatalogQuery } from "@/lib/model-catalog.ts";
import { refreshProviders, useProviderReadiness } from "@/lib/provider-readiness.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";

/** Provider reads share the same recovery action in General and the composer. */
export function useProviderReadError() {
  const providers = useProviderStatuses();
  const readiness = useProviderReadiness();
  const catalog = useCatalogQuery();
  const queries = useQueryClient();
  return {
    providers:
      (providers.isError || readiness.isError) && !providers.data
        ? "Couldn't check providers"
        : undefined,
    models: catalog.isError ? "Couldn't load models" : undefined,
    retry() {
      refreshProviders(queries);
      void queries.invalidateQueries({ queryKey: catalogKey });
    },
  };
}

export function ProviderReadError(props: { message: string; retry(): void }) {
  return (
    <span role="alert" className="inline-flex items-center gap-1 text-ui text-muted-foreground">
      {props.message}
      <IconButton size="sm" icon={ArrowClockwiseIcon} label="Retry" onClick={props.retry} />
    </span>
  );
}
