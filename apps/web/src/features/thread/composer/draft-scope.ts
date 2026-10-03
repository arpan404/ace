import { useClient, useConnectionState } from "@ace/client-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { draftScopes } from "../sources/context-source.ts";

/**
 * The New thread composer's draft scope for `workspaceId`: undefined until the daemon grants it
 * (and while offline). `adopt()` marks it taken by the thread that was just created, so it is
 * not released when the page closes.
 */
export function useDraftScope(workspaceId: string | undefined): {
  draftId: string | undefined;
  adopt(): void;
} {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [scope, setScope] = useState<{ workspaceId: string; draftId: string }>();
  const adopted = useRef<string>(undefined);
  useEffect(() => {
    if (!workspaceId || !ready) return;
    const scopes = draftScopes(client);
    let live = true;
    let granted: string | undefined;
    scopes.create(workspaceId).then(
      (draftId) => {
        granted = draftId;
        if (live) setScope({ workspaceId, draftId });
        else scopes.release(draftId);
      },
      () => {
        // No scope: mentions stay empty and files ask to wait; sending still works.
      },
    );
    return () => {
      live = false;
      if (granted && adopted.current !== granted) scopes.release(granted);
    };
  }, [client, workspaceId, ready]);
  const draftId = scope && scope.workspaceId === workspaceId ? scope.draftId : undefined;
  const adopt = useCallback(() => {
    adopted.current = draftId;
  }, [draftId]);
  return { draftId, adopt };
}
