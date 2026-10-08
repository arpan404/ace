import { readJson, writeJson } from "@ace/ui-core";
import type { ProviderKind } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { refreshProviders } from "@/lib/provider-readiness.ts";
import { CliInstallController } from "./cli-install-controller.ts";

export function useInstall(provider: ProviderKind, acpAgentId?: string) {
  const client = useClient();
  const queries = useQueryClient();
  const { storage } = useLayout();
  const { url } = useDaemonConnection();
  const origin = new URL(url).origin;
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
