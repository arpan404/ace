import { mergeSpadeModels, type SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { readLiveModels, readModels, readSubscriptions } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/** Every Spade models read; one machine's under `[...modelsKey, machine key]`. */
export const modelsKey = ["spade", "models"] as const;

/** How often the list is read again while the keychain hasn't answered for some keys. */
const keysPendingPoll = 1_000;

/**
 * The person's endpoints, presets and fast model, on the machine in scope. Spade answers at once
 * even while a keychain prompt is open; until the keychain answers, the list is read again.
 */
export function useSpadeModels(ready: boolean) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: [...modelsKey, machine],
    queryFn: ({ signal }) => readModels(client, { signal }),
    enabled: ready,
    refetchInterval: (query) => (query.state.data?.keysPending ? keysPendingPoll : false),
  });
}

/**
 * The models to pick from on one endpoint: its live list merged with what the person saved.
 * While the live list loads or fails, the saved ones still show (`live` says how it went).
 */
export function useEndpointModels(endpoint: SpadeEndpoint | undefined) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const live = useQuery({
    queryKey: [...modelsKey, machine, "live", endpoint?.id ?? ""],
    queryFn: ({ signal }) => readLiveModels(client, endpoint?.id ?? "", { signal }),
    // Not while its key isn't known yet: the endpoint's list would wait on the keychain too.
    enabled: endpoint !== undefined && (!endpoint.needsKey || endpoint.keySet === true),
    staleTime: 60_000,
    retry: false,
  });
  return { models: mergeSpadeModels(endpoint?.models ?? [], live.data), live };
}

/** The person's subscriptions, through ace; a failed read shows none (ace may be away). */
export function useSpadeSubscriptions(ready: boolean) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: [...modelsKey, machine, "subscriptions"],
    queryFn: ({ signal }) => readSubscriptions(client, { signal }),
    enabled: ready,
    staleTime: 60_000,
    retry: false,
  });
}
