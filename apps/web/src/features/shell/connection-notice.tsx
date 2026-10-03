import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientError } from "@ace/client";
import { Link } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner.tsx";

const fatalReasons: Partial<Record<ClientError["code"], string>> = {
  auth: "the daemon didn't accept this token",
  protocol: "this app and the daemon speak different protocol versions",
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
  return (
    <div
      role="status"
      className="fx-view-in flex h-8 shrink-0 items-center justify-center gap-2 border-b text-sm text-muted-foreground"
    >
      {state === "reconnecting" && (
        <>
          <Spinner />
          Reconnecting to the daemon…
        </>
      )}
      {state === "offline" && "Offline. Anything you send goes out when the connection returns."}
      {state === "fatal" && (
        <>
          Can't connect:{" "}
          {(client.error && fatalReasons[client.error.code]) ?? "the daemon closed the connection"}.
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
