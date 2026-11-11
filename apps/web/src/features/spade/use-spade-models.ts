import { mergeSpadeModels, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readLiveModels, readModels } from "./spade-api.ts";

export const modelsKey = ["spade", "models"] as const;

/** The person's endpoints, presets and fast model. */
export function useSpadeModels(ready: boolean) {
  return useDaemonQuery({
    queryKey: modelsKey,
    read: (client, signal) => readModels(client, { signal }),
    enabled: ready,
  });
}

/**
 * The models to pick from on one endpoint: its live list merged with what the person saved.
 * While the live list loads or fails, the saved ones still show (`live` says how it went).
 */
export function useEndpointModels(endpoint: SpadeEndpoint | undefined) {
  const live = useDaemonQuery({
    queryKey: [...modelsKey, "live", endpoint?.id ?? ""],
    read: (client, signal) => readLiveModels(client, endpoint?.id ?? "", { signal }),
    enabled: endpoint !== undefined && (!endpoint.needsKey || endpoint.keySet),
    staleTime: 60_000,
    retry: false,
  });
  return { models: mergeSpadeModels(endpoint?.models ?? [], live.data), live };
}
