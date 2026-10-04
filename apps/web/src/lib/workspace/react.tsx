import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { KeyValueStorage } from "@ace/ui-core";
import { workspaceActions, type WorkspaceActions } from "./actions.ts";
import { emptyWorkspace, type ScopeWorkspace } from "./model.ts";
import { WorkspaceStore, type PreferredSizes } from "./store.ts";

const WorkspaceContext = createContext<WorkspaceStore | undefined>(undefined);

/** One workspace store per app, persisted to the injected storage. */
export function WorkspaceProvider(props: {
  storage?: KeyValueStorage | undefined;
  children: ReactNode;
}) {
  const [store] = useState(() => new WorkspaceStore({ storage: props.storage }));
  return <WorkspaceContext.Provider value={store}>{props.children}</WorkspaceContext.Provider>;
}

export function useWorkspaceStore(): WorkspaceStore {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error("useWorkspaceStore needs a <WorkspaceProvider>");
  return store;
}

/** A scope's docks and tabs, live. Re-renders only when that scope changes. */
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

export function usePreferredSizes(): PreferredSizes {
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
