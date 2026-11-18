import { useEffect, useState } from "react";
import { daemonStartWords } from "@/lib/startup/startup-activity.ts";
import { desktopDaemon, type DesktopDaemonStatus } from "./desktop.ts";

/**
 * While the desktop app starts (or restarts) its daemon, the step it is on in one sentence
 * (`daemonStartWords`); undefined once the daemon runs, and always in a browser.
 */
export function useDaemonStartWords(scope: object = globalThis): string | undefined {
  const [status, setStatus] = useState<DesktopDaemonStatus | undefined>(undefined);
  useEffect(() => {
    const daemon = desktopDaemon(scope);
    if (!daemon) return;
    // The current state, unless a newer one has already arrived as an event.
    let heard = false;
    const stop = daemon.onStatus((next) => {
      heard = true;
      setStatus(next);
    });
    void daemon.status().then(
      (next) => {
        if (next && !heard) setStatus(next);
      },
      () => {},
    );
    return stop;
  }, [scope]);
  return status && daemonStartWords(status);
}
