import { useEffect, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { useDesktopCliInstallState } from "../lib/desktopCliInstallReactQuery";

export function DesktopCliInstallToastBridge() {
  const cliInstallQuery = useDesktopCliInstallState();
  const cliInstallState = cliInstallQuery.data ?? null;
  const installToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (!cliInstallState || cliInstallState.status !== "installing") {
      if (installToastIdRef.current !== null) {
        toastManager.close(installToastIdRef.current);
        installToastIdRef.current = null;
      }
      return;
    }

    const progressPercent = Math.max(
      0,
      Math.min(100, Math.round(cliInstallState.progressPercent ?? 0)),
    );
    const toastPayload = {
      type: "loading" as const,
      title: "Installing ace CLI",
      description:
        cliInstallState.message ?? `Installing the \`ace\` CLI. (${String(progressPercent)}%)`,
      timeout: 0,
      data: {
        progressPercent,
      },
    };

    if (installToastIdRef.current === null) {
      installToastIdRef.current = toastManager.add(toastPayload);
      return;
    }

    toastManager.update(installToastIdRef.current, toastPayload);
  }, [cliInstallState]);

  useEffect(
    () => () => {
      if (installToastIdRef.current !== null) {
        toastManager.close(installToastIdRef.current);
        installToastIdRef.current = null;
      }
    },
    [],
  );

  return null;
}
