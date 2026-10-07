import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { workspaceActions, type WorkspaceActions } from "./actions.ts";
import { emptyWorkspace, type ScopeWorkspace } from "./model.ts";
import { WorkspaceStore } from "./store.ts";

/**
 * The app's workspace store: created the first time a screen with a side panel (or a command
 * acting on one) asks, so the shell's first paint doesn't carry its code (ADR 0056). One per
 * `<LayoutProvider>`, persisted to that provider's storage.
 */
export function useWorkspaceStore(): WorkspaceStore {
  const { storage, workspaceStore } = useLayout();
  return workspaceStore(() => new WorkspaceStore({ storage }));
}

/** A scope's side panel and tabs, live. Re-renders only when that scope changes. */
export function useScopeWorkspace(scope: string | undefined): ScopeWorkspace {
  const store = useWorkspaceStore();
  const subscribe = useCallback(
    (listener: () => void) => (scope ? store.subscribe(scope, listener) : () => {}),
    [store, scope],
  );
  const read = useCallback(() => (scope ? store.get(scope) : emptyWorkspace), [store, scope]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Open, show, close and arrange a scope's tabs (a thread's: pass its id). */
export function useWorkspaceActions(scope: string): WorkspaceActions {
  const store = useWorkspaceStore();
  return useMemo(() => workspaceActions(store, scope), [store, scope]);
}

/** The side panel's width for scopes without one of their own. */
export function usePreferredSize(): number {
  const store = useWorkspaceStore();
  const subscribe = useCallback((listener: () => void) => store.subscribeGlobal(listener), [store]);
  const read = useCallback(() => store.preferred, [store]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The scope whose screen is showing, if any: global commands act on it. */
export function useFocusedScope(): string | undefined {
  const store = useWorkspaceStore();
  const subscribe = useCallback((listener: () => void) => store.subscribeGlobal(listener), [store]);
  const read = useCallback(() => store.focused, [store]);
  return useSyncExternalStore(subscribe, read, read);
}
