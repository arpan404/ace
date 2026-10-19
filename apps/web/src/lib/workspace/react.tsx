import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { workspaceActions, type WorkspaceActions } from "./actions.ts";
import { emptyWorkspace, type ScopeWorkspace } from "./model.ts";
import type { PanelPlace } from "./places.ts";
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

/**
 * The panel a view is drawn in, so what it opens (a new terminal) opens beside it. Outside
 * both panels, "auto": where the person chose.
 */
export const PanelPlaceContext = createContext<PanelPlace | "auto">("auto");

/** Open, show, close and arrange a scope's tabs (a thread's: pass its id). */
export function useWorkspaceActions(scope: string): WorkspaceActions {
  const store = useWorkspaceStore();
  const here = useContext(PanelPlaceContext);
  return useMemo(() => workspaceActions(store, scope, here), [store, scope, here]);
}

function useGlobal<T>(read: (store: WorkspaceStore) => T): T {
  const store = useWorkspaceStore();
  const subscribe = useCallback((listener: () => void) => store.subscribeGlobal(listener), [store]);
  const get = useCallback(() => read(store), [store, read]);
  return useSyncExternalStore(subscribe, get, get);
}

const readBottomHeight = (store: WorkspaceStore) => store.preferredBottom;
const readPlace = (store: WorkspaceStore) => store.preferredPlace;
const readFits = (store: WorkspaceStore) => store.bottomFits;

/** The bottom panel's height on this device. */
export function useBottomHeight(): number {
  return useGlobal(readBottomHeight);
}

/** Where terminals (the bottom panel's kinds) open on this device, and a way to change it. */
export function usePreferredPlace(): [PanelPlace, (place: PanelPlace) => void] {
  const store = useWorkspaceStore();
  const place = useGlobal(readPlace);
  return [place, useCallback((next: PanelPlace) => store.setPreferredPlace(next), [store])];
}

/** Whether the screen showing has room for the bottom panel. */
export function useBottomFits(): boolean {
  return useGlobal(readFits);
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
