import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { daemonErrorCode, describeDaemonError, useDaemonReady } from "@/lib/daemon-command.ts";
import { catalogKey } from "@/lib/model-catalog.ts";

/** What the Refresh models control can do now. */
export interface RefreshModels {
  /** Discover one provider's models again (every provider's without one). */
  refresh(provider: ProviderKind | undefined, instance?: string): void;
  /**
   * Load one row's models because the person asked (Load models): the one request that starts
   * an ACP agent for its list. The daemon admits it only from the person's own device.
   */
  load(instance: string): void;
  /** A refresh this window asked for is running. */
  pending: boolean;
  /** Why it can't refresh: offline, or this device may only read. */
  reason: string | undefined;
}

const readOnly = "This device can view models but not refresh them";
class LoadRefused extends Error {}
/** Daemons that refused this device a refresh: it only has the read scope. */
const refused = new WeakSet<ClientApi>();

/**
 * `models.refresh`, which needs the operate scope: the daemon discovers again and replies once
 * done, while its `models.changed` pushes keep every picker current. A device that may only
 * read learns so from the first refusal and the control says why from then on.
 */
export function useRefreshModels(): RefreshModels {
  const client = useClient();
  const queryClient = useQueryClient();
  const daemon = useDaemonReady();
  const toast = useToast();
  const [forbidden, setForbidden] = useState(() => refused.has(client));
  const mutation = useMutation({
    mutationFn: async (
      request:
        | { provider?: ProviderKind | undefined; instance?: string | undefined }
        | { load: string },
    ) => {
      if (!("load" in request)) return client.request({ type: "models.refresh", filter: request });
      const reply = await client.request({ type: "models.load", instance: request.load });
      // A refusal (not the person's device) is the daemon's own sentence.
      if ("ok" in reply.result && !reply.result.ok) throw new LoadRefused(reply.result.reason);
      return reply;
    },
    onError: (error) => {
      if (error instanceof LoadRefused)
        return toast.error({ title: "Couldn't load models", description: error.message });
      const code = daemonErrorCode(error);
      if (code !== "forbidden")
        return toast.error({
          title: "Couldn't refresh models",
          description: describeDaemonError(code),
        });
      refused.add(client);
      setForbidden(true);
    },
    // The reply carries one page; read the whole catalog again, as the pushes would.
    onSettled: () => queryClient.invalidateQueries({ queryKey: catalogKey }),
  });
  return {
    refresh: (provider, instance) => {
      if (daemon.ready && !forbidden) mutation.mutate({ provider, instance });
    },
    load: (instance) => {
      if (daemon.ready && !forbidden) mutation.mutate({ load: instance });
    },
    pending: mutation.isPending,
    reason: forbidden ? readOnly : daemon.reason,
  };
}
