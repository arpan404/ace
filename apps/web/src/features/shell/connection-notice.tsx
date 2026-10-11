import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientError } from "@ace/client";
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
  protocol: "the connection could not be read; try again or update ace",
  limit: "the connection exceeded its capacity; try again",
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
  if (state === "ready" || state === "connecting" || state === "starting") return null;
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
          <IconButton
            icon={ArrowClockwiseIcon}
            label="Retry now"
            size="sm"
            onClick={() => client.reconnectNow()}
          />
        </>
      )}
      {state === "fatal" && (
        <>
          Can't connect:{" "}
          {(client.error && fatalReasons[client.error.code]) ?? "ace closed the connection"}.
          <IconButton
            icon={ArrowClockwiseIcon}
            label="Try again"
            size="sm"
            onClick={connection.retry}
          />
        </>
      )}
    </div>
  );
}
