import { useEffect, useMemo } from "react";
import { useSelection } from "@ace/client-react";
import { desktopDeviceTabs } from "@/boot/desktop-device-tabs.ts";
import { machineSecrets } from "@/boot/machine-secrets.ts";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { tunnelPathFor } from "./tunnel-path.ts";

/**
 * While a device tab of `machineId` shows, tells the desktop's main process which path the
 * machine connection is on, so the machine's tunnel opens there (ADR 0194) and follows it when
 * the connection moves. The credential goes to this app's own main process only.
 */
export function useTunnelPath(machineId: string | undefined): void {
  const pool = useMachinePool();
  const selection = useMemo(
    () => (pool && machineId ? pool.status(machineId) : undefined),
    [pool, machineId],
  );
  const state = useSelection(selection);
  const entry = state?.entry;
  const online = state?.status === "online";
  const path = state?.path;
  useEffect(() => {
    const tabs = desktopDeviceTabs();
    if (!tabs || !machineId || !entry) return;
    let alive = true;
    const secrets = machineSecrets(localStorage, sessionStorage);
    void secrets
      .get(JSON.stringify([entry.hostId, entry.deviceId]))
      .then((token) => {
        if (!alive) return;
        const next = tunnelPathFor({ entry, online, path, token: token ?? undefined });
        return tabs.tunnelPath({ machineId, path: next ?? null });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [machineId, entry, online, path]);
}
