import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientError } from "@ace/client";
import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** What still works offline and what waits; it loads when the connection first drops. */
const DeferredOfflineNotice = deferredComponent(() =>
  import("./offline-notice.tsx").then((module) => module.OfflineNotice),
);
const offlineWords = "Offline · messages, answers and Stop will send when the connection returns";

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
  if (state === "ready" || state === "connecting") return null;
  if (state === "offline")
    return (
      <Suspense
        fallback={
          <div className="fx-view-in shrink-0 border-b text-sm text-muted-foreground">
            <div
              role="status"
              className="flex min-h-8 items-center justify-center gap-2 px-3 py-1 text-center"
            >
              {offlineWords}
            </div>
          </div>
        }
      >
        <DeferredOfflineNotice.Component words={offlineWords} />
      </Suspense>
    );
  return (
    <div
      role="status"
      className="fx-view-in flex h-8 shrink-0 items-center justify-center gap-2 border-b text-sm text-muted-foreground"
    >
      {state === "reconnecting" && (
        <>
          <Spinner />
          Reconnecting to ace…
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
