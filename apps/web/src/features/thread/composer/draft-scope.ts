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
  retry(): void;
} {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [attempt, setAttempt] = useState(0);
  const retryScope = useCallback(() => setAttempt((value) => value + 1), []);
  const [scope, setScope] = useState<{ workspaceId: string; draftId: string; attempt: number }>();
  const adopted = useRef<string>(undefined);
  useEffect(() => {
    if (!workspaceId || !ready) return;
    const scopes = draftScopes(client);
    let live = true;
    let granted: string | undefined;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const create = () => {
      attempts++;
      void scopes.create(workspaceId).then(
        (draftId) => {
          granted = draftId;
          if (live) setScope({ workspaceId, draftId, attempt });
          else scopes.release(draftId);
        },
        () => {
          if (live && attempts < 3) retry = setTimeout(create, 1000 * attempts);
        },
      );
    };
    create();
    return () => {
      if (retry) clearTimeout(retry);
      live = false;
      if (granted && adopted.current !== granted) scopes.release(granted);
    };
  }, [client, workspaceId, ready, attempt]);
  const draftId =
    ready && scope && scope.workspaceId === workspaceId && scope.attempt === attempt
      ? scope.draftId
      : undefined;
  const adopt = useCallback(() => {
    adopted.current = draftId;
  }, [draftId]);
  return { draftId, adopt, retry: retryScope };
}
