import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { WorkspaceStore } from "./workspace/store.ts";

/**
 * Shell layout: the sidebar, the palette, and whether a screen's right dock is showing.
 * Local UI state, persisted to storage. The docks' tabs and sizes are per scope (thread) in the
 * workspace store (`lib/workspace`), which reads the same storage.
 */
export const ShellLayout = z.object({
  /** The sidebar beside the rail is on screen (⌘\ hides it; the rail stays). */
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
  /** A screen is showing its right dock now (not just remembered open), so a crowded window
   * can give it the sidebar's room. Set by the dock itself. */
  rightPanelShown: boolean;
  /** Put the showing right dock away (asking for the sidebar back on a crowded window). */
  hideRightPanel(): void;
  /** The dock registers how to hide itself while it shows; undefined when it hides. */
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rightPanel, setRightPanelState] = useState<{ hide(): void }>();
  // Stable, so the dock registering itself doesn't re-run on every layout change.
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
      rightPanelShown: rightPanel !== undefined,
      hideRightPanel: () => rightPanel?.hide(),
      setRightPanel,
      storage,
      workspaceStore,
      setSidebarOpen: (open) => change((p) => ({ ...p, sidebarOpen: open })),
    }),
    [layout, paletteOpen, rightPanel, setRightPanel, change, storage, workspaceStore],
  );
  return <LayoutContext.Provider value={value}>{props.children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout needs a <LayoutProvider>");
  return value;
}
