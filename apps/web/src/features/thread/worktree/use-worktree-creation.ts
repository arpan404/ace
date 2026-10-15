import type { ClientApi } from "@ace/client";
import {
  WorktreeCreations,
  type WorktreeAction,
  type WorktreeCreationState,
} from "@ace/client/worktree-creations";
import { useClient } from "@ace/client-react";
import type { WorktreeCreationProgress } from "@ace/protocol";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

export type { WorktreeAction, WorktreeCreationState } from "@ace/client/worktree-creations";

/** One store per client: its pushes, `get`s and actions, shared by every view of a create. */
const stores = new WeakMap<ClientApi, WorktreeCreations>();
function storeFor(client: ClientApi): WorktreeCreations {
  let store = stores.get(client);
  if (!store) {
    store = new WorktreeCreations(client);
    stores.set(client, store);
  }
  return store;
}

/**
 * Forget a settled failed or cancelled start on the daemon (its kept worktree too) once its
 * message is back in New thread. Best effort: a refusal leaves it for the daemon's own cleanup.
 */
export function dismissWorktreeStart(client: ClientApi, commandId: string): void {
  void storeFor(client).act(commandId, "dismiss");
}

/**
 * A cancelled start the person leaves is forgotten on the daemon, as one returned to New
 * thread is. Its message stays on this device as a failed send with Retry and Edit.
 */
export function useDismissCancelledOnLeave(
  commandId: string | undefined,
  progress: WorktreeCreationProgress | undefined,
): void {
  const client = useClient();
  const latest = useRef(progress);
  useEffect(() => {
    latest.current = progress;
  }, [progress]);
  useEffect(
    () => () => {
      const last = latest.current;
      if (commandId && last?.state === "cancelled" && last.cleanupComplete)
        dismissWorktreeStart(client, commandId);
    },
    [client, commandId],
  );
}

const idle = { getSnapshot: () => undefined, subscribe: () => () => {} };

/**
 * The worktree a pending create is being made in, and its actions. Undefined for no command;
 * `progress` is undefined until the daemon has reported (or for a create that made none).
 */
export function useWorktreeCreation(commandId: string | undefined): {
  state: WorktreeCreationState | undefined;
  act(action: WorktreeAction): void;
} {
  const client = useClient();
  const store = storeFor(client);
  const selection = useMemo(() => (commandId ? store.state(commandId) : idle), [store, commandId]);
  const state = useSyncExternalStore(selection.subscribe, selection.getSnapshot);
  const act = useCallback(
    (action: WorktreeAction) => {
      if (commandId) void store.act(commandId, action);
    },
    [store, commandId],
  );
  return { state, act };
}
