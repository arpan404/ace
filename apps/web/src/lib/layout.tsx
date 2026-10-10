import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { WorkspaceStore } from "./workspace/store.ts";

/**
 * Shell layout: the sidebar, the palette and search dialogs, and whether a screen's side panel
 * is showing.
 * Local UI state, persisted to storage. The side panel's tabs and width are per scope (thread) in the
 * workspace store (`lib/workspace`), which reads the same storage.
 */
export const ShellLayout = z.object({
  /** The sidebar is on screen (⌘\ hides it). */
  sidebarOpen: z.catch(z.boolean(), true),
});
export type ShellLayout = z.infer<typeof ShellLayout>;

const defaultLayout: ShellLayout = { sidebarOpen: true };
const storageKey = "ace.layout";

interface LayoutValue {
  layout: ShellLayout;
  setSidebarOpen(open: boolean): void;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  /** The search dialog, open with the words it starts from; undefined while it is closed. */
  search: { query: string } | undefined;
  /** Open the search dialog over the current screen, optionally with words already in it. */
  openSearch(query?: string): void;
  closeSearch(): void;
  /** A screen is showing its side panel now (not just remembered open), so a crowded window
   * can give it the sidebar's room. Set by the panel itself. */
  rightPanelShown: boolean;
  /** Put the showing side panel away (asking for the sidebar back on a crowded window). */
  hideRightPanel(): void;
  /** The panel registers how to hide itself while it shows; undefined when it hides. */
  setRightPanel(hide: (() => void) | undefined): void;
  /** The injected key-value storage, for features that persist their own local UI state. */
  storage: KeyValueStorage | undefined;
  /** This app's workspace store, made by `create` on first use (`lib/workspace` loads lazily). */
  workspaceStore(create: () => WorkspaceStore): WorkspaceStore;
}
const LayoutContext = createContext<LayoutValue | undefined>(undefined);

export function LayoutProvider(props: {
  storage?: KeyValueStorage | undefined;
  children: ReactNode;
}) {
  const { storage } = props;
  const [layout, setLayout] = useState(() =>
    readJson(storage, storageKey, ShellLayout, defaultLayout),
  );
  const [paletteOpen, setPaletteState] = useState(false);
  const [search, setSearch] = useState<{ query: string }>();
  const setPaletteOpen = useCallback((open: boolean) => {
    if (open) setSearch(undefined);
    setPaletteState(open);
  }, []);
  // Stable, so a screen that opens search from an effect runs it once.
  const openSearch = useCallback(
    (query = "") => {
      setPaletteOpen(false);
      setSearch({ query });
    },
    [setPaletteOpen],
  );
  const closeSearch = useCallback(() => setSearch(undefined), []);
  const [rightPanel, setRightPanelState] = useState<{ hide(): void }>();
  // Stable, so the panel registering itself doesn't re-run on every layout change.
  const setRightPanel = useCallback(
    (hide: (() => void) | undefined) => setRightPanelState(hide ? { hide } : undefined),
    [],
  );
  const [workspaceStore] = useState(() => {
    let store: WorkspaceStore | undefined;
    return (create: () => WorkspaceStore) => (store ??= create());
  });
  const change = useCallback(
    (next: (previous: ShellLayout) => ShellLayout) =>
      setLayout((previous) => {
        const value = next(previous);
        writeJson(storage, storageKey, value);
        return value;
      }),
    [storage],
  );
  const value = useMemo<LayoutValue>(
    () => ({
      layout,
      paletteOpen,
      setPaletteOpen,
      search,
      openSearch,
      closeSearch,
      rightPanelShown: rightPanel !== undefined,
      hideRightPanel: () => rightPanel?.hide(),
      setRightPanel,
      storage,
      workspaceStore,
      setSidebarOpen: (open) => change((p) => ({ ...p, sidebarOpen: open })),
    }),
    [
      layout,
      paletteOpen,
      setPaletteOpen,
      search,
      openSearch,
      closeSearch,
      rightPanel,
      setRightPanel,
      change,
      storage,
      workspaceStore,
    ],
  );
  return <LayoutContext.Provider value={value}>{props.children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout needs a <LayoutProvider>");
  return value;
}
