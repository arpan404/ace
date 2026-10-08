import type { RegistryAgent, RegistryInstallation, RegistryInstallPlan } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useSettingsBackend, settingsQueries } from "../data/use-settings.ts";
import {
  cancelInstall,
  installAgent,
  planInstall,
  readInstallProgress,
  readRegistry,
  refreshRegistry,
} from "./registry-data.ts";

export const registryKey = ["acp-registry"] as const;

/** A list read this recently isn't downloaded again just because the browser opened. */
const revalidateAfterMs = 10 * 60_000;

/**
 * The registry, stale-while-revalidate: the daemon's cached index shows at once, and opening
 * the browser downloads it again in the background when it's stale or older than ten minutes.
 * `now` is the browser's clock, injected by the caller.
 */
export function useRegistry(now: number) {
  const client = useClient();
  const queryClient = useQueryClient();
  const list = useDaemonQuery({ queryKey: registryKey, read: readRegistry });
  const refresh = useMutation({
    mutationFn: () => refreshRegistry(client),
    onSettled: () => queryClient.invalidateQueries({ queryKey: registryKey }),
  });
  const revalidated = useRef(false);
  const data = list.data;
  useEffect(() => {
    if (!data || revalidated.current) return;
    revalidated.current = true;
    if (data.stale || data.fetchedAt === undefined || now - data.fetchedAt > revalidateAfterMs)
      refresh.mutate();
  }, [data, now, refresh]);
  return { list, refresh };
}

/** The install plan for one entry, read when its page opens. */
export function useInstallPlan(agent: RegistryAgent) {
  return useDaemonQuery({
    queryKey: [...registryKey, "plan", agent.acpAgentId, agent.version],
    read: (client) => planInstall(client, agent),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export type InstallState =
  | { step: "review" }
  | { step: "confirm" }
  | { step: "installing"; intentId: string; cancelling: boolean }
  | { step: "installed"; installation: RegistryInstallation }
  | { step: "failed"; message: string };

/**
 * Review, confirm, install: an install runs only after an explicit confirmation, as an intent
 * carrying the reviewed plan's digest. `intentId` comes from the caller (the browser's UUIDs).
 */
export function useInstall(newIntentId: () => string) {
  const client = useClient();
  const queryClient = useQueryClient();
  const backend = useSettingsBackend();
  const [state, setState] = useState<InstallState>({ step: "review" });
  const install = useMutation({
    mutationFn: (input: { plan: RegistryInstallPlan; intentId: string }) =>
      installAgent(client, input.plan, input.intentId),
    onSuccess: (installation) => setState({ step: "installed", installation }),
    onError: (error) => setState({ step: "failed", message: error.message }),
    // Installed or not, the list and Providers read the daemon again.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: registryKey }),
        queryClient.invalidateQueries({ queryKey: settingsQueries.providers(backend).queryKey }),
      ]),
  });
  const intentId = state.step === "installing" ? state.intentId : undefined;
  const progress = useDaemonQuery({
    queryKey: [...registryKey, "progress", intentId],
    read: readInstallProgress,
    enabled: intentId !== undefined,
    refetchInterval: 400,
    gcTime: 0,
  });
  const active = progress.data?.intentId === intentId ? progress.data : undefined;
  return {
    state,
    progress: active ?? undefined,
    confirm: () => setState({ step: "confirm" }),
    back: () => setState({ step: "review" }),
    start(plan: RegistryInstallPlan) {
      const id = newIntentId();
      setState({ step: "installing", intentId: id, cancelling: false });
      install.mutate({ plan, intentId: id });
    },
    cancel() {
      if (state.step !== "installing") return;
      setState({ ...state, cancelling: true });
      void cancelInstall(client, state.intentId).catch(() => false);
    },
  };
}
