import { useClient, useConnectionState } from "@ace/client-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { ConsumedDraftScope, draftScopes } from "../sources/context-source.ts";

/**
 * The New thread composer's draft scope for `workspaceId`: undefined until the daemon grants it
 * (and while offline). `adopt()` marks it taken by the thread that was just created, so it is
 * not released when the page closes.
 */
export function useDraftScope(
  workspaceId: string | undefined,
  owner?: {
    epoch?: number | undefined;
    read(): string | undefined;
    granted(id: string): void;
    owns(id: string): boolean;
    consumed?(id: string): void;
  },
): {
  draftId: string | undefined;
  adopt(): void;
  retire(id: string): void;
  retry(): void;
} {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [attempt, setAttempt] = useState(0);
  const retryScope = useCallback(() => setAttempt((value) => value + 1), []);
  const epoch = owner?.epoch ?? 0;
  const [scope, setScope] = useState<{
    workspaceId: string;
    draftId: string;
    attempt: number;
    epoch: number;
  }>();
  const adopted = useRef<string>(undefined);
  const currentOwner = useEffectEvent(() => owner);
  useEffect(() => {
    if (!workspaceId || !ready) return;
    const scopes = draftScopes(client);
    // Cleanup must consult the owner of this scope, even after the project changes.
    const scopeOwner = currentOwner();
    let live = true;
    let granted: string | undefined;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const create = () => {
      attempts++;
      const remembered = scopeOwner?.read();
      void (
        remembered
          ? scopes.resume(remembered).catch((error: unknown) => {
              if (error instanceof ConsumedDraftScope) scopeOwner?.consumed?.(remembered);
              return scopes.create(workspaceId);
            })
          : scopes.create(workspaceId)
      ).then(
        (draftId) => {
          granted = draftId;
          if (live) {
            scopeOwner?.granted(draftId);
            setScope({ workspaceId, draftId, attempt, epoch });
          } else if (!scopeOwner?.owns(draftId)) scopes.release(draftId);
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
      if (granted && adopted.current !== granted && !scopeOwner?.owns(granted))
        scopes.release(granted);
    };
  }, [client, workspaceId, ready, attempt, epoch]);
  const draftId =
    ready &&
    scope &&
    scope.workspaceId === workspaceId &&
    scope.attempt === attempt &&
    scope.epoch === epoch
      ? scope.draftId
      : undefined;
  const adopt = useCallback(() => {
    adopted.current = draftId;
  }, [draftId]);
  const retire = useCallback(
    (id: string) => {
      draftScopes(client).retire(id);
      if (id === draftId) {
        adopted.current = id;
        retryScope();
      }
    },
    [client, draftId, retryScope],
  );
  return { draftId, adopt, retire, retry: retryScope };
}
