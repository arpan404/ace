import { useEffect, useMemo } from "react";
import { machineSecretKey } from "@ace/client/machines";
import { useSelection } from "@ace/client-react";
import { desktopDeviceTabs } from "@/boot/desktop-device-tabs.ts";
import { machineSecrets } from "@/boot/machine-secrets.ts";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { tunnelPathFor } from "./tunnel-path.ts";

/**
 * While a device tab of `machineId` shows, tells the desktop's main process which path the
 * machine connection is on, so the machine's tunnel opens there (ADR 0194) and follows it when
 * the connection moves or its credential changes. The credential goes to this app's own main
 * process only. Main holds it as this window's lease on the machine: a machine gone offline or
 * removed from this device ends the lease here; the window's last device tab of the machine
 * closing, or the window reloading or closing, ends it in main. A hidden tab keeps its lease
 * (its page still runs), which is why this effect's cleanup doesn't end it.
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
    if (!tabs || !machineId) return;
    if (!entry) {
      void tabs.tunnelPath({ machineId, path: null });
      return;
    }
    let alive = true;
    const secrets = machineSecrets(localStorage, sessionStorage);
    void secrets
      .get(machineSecretKey(entry))
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
