import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientError } from "@ace/client";
import { Link } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** What still works offline and what waits; it loads when the connection first drops. */
const DeferredOfflineNotice = deferredComponent(() =>
  import("./offline-notice.tsx").then((module) => module.OfflineNotice),
);
const offlineWords = "Offline";

const fatalReasons: Partial<Record<ClientError["code"], string>> = {
  auth: "ace didn't accept this token",
  protocol: "this app and ace speak different protocol versions",
  storage: "this browser blocked local storage",
};

/**
 * Connection trouble, said once and quietly under the header. Never implies anything about
 * agent progress: agents keep working on the daemon while this window is away.
 */
export function ConnectionNotice() {
  const state = useConnectionState();
  const client = useClient();
  const connection = useDaemonConnection();
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (state !== "reconnecting") return;
    const timer = setTimeout(() => setLate(true), 10_000);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [state]);
  if (state === "ready" || state === "connecting") return null;
  if (state === "offline")
    return (
      <Suspense
        fallback={
          <div className="text-xs text-muted-foreground">
            <div role="status" className="flex items-center gap-2">
              {offlineWords}
            </div>
          </div>
        }
      >
        <DeferredOfflineNotice.Component words={offlineWords} />
      </Suspense>
    );
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      {state === "reconnecting" && (
        <>
          <Spinner />
          {late ? "Offline" : "Reconnecting"}
          <button
            type="button"
            className="text-foreground hover:underline"
            onClick={() => connection.retry()}
          >
            Retry
          </button>
        </>
      )}
      {state === "fatal" && (
        <>
          Can't connect:{" "}
          {(client.error && fatalReasons[client.error.code]) ?? "ace closed the connection"}.
          <Link
            to="/settings/general"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Connection settings
          </Link>
        </>
      )}
    </div>
  );
}
