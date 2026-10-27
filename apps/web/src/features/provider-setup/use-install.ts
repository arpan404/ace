import { CliInstallController, readJson, writeJson } from "@ace/ui-core";
import type { ProviderKind } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useLayout } from "@/lib/layout.tsx";
import { refreshProviders } from "@/lib/provider-readiness.ts";

export function useInstall(provider: ProviderKind, acpAgentId?: string) {
  const client = useClient();
  const queries = useQueryClient();
  const { storage } = useLayout();
  const { url } = useDaemonConnection();
  // The machine the install runs on: Settings may point this client at another machine than the
  // window's own, so its host id names it; the window's address only until that is known.
  const hostId = useHostIdentity()?.hostId;
  const origin = hostId ?? new URL(url).origin;
  const controller = useMemo(() => {
    const key = `ace.provider.install.${encodeURIComponent(origin)}.${provider}.${acpAgentId ?? "default"}`;
    return new CliInstallController(
      client,
      { provider, ...(acpAgentId ? { acpAgentId } : {}) },
      {
        session: readJson(storage, key, z.string().min(1).max(256).nullable(), null) ?? undefined,
        remember: (session) => writeJson(storage, key, session ?? null),
      },
    );
  }, [client, provider, acpAgentId, storage, origin]);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const state = view.kind === "progress" ? view.progress.state : undefined;
  useEffect(() => {
    if (state === "succeeded" || state === "cancelled") {
      refreshProviders(queries);
      void queries.invalidateQueries({ queryKey: ["acp-registry"] });
    }
  }, [state, queries]);
  return { controller, view };
}
