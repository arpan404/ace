import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { WorkspaceProvider } from "./workspace/react.tsx";

/**
 * Shell layout: the second sidebar, the palette, and whether a screen's right dock is showing.
 * Local UI state, persisted to storage. The docks' tabs and sizes are per scope (thread) in the
 * workspace store (`lib/workspace`), provided here too.
 */
export const ShellLayout = z.object({
  sidebarOpen: z.catch(z.boolean(), true),
});
export type ShellLayout = z.infer<typeof ShellLayout>;

const defaultLayout: ShellLayout = { sidebarOpen: true };
const storageKey = "ace.layout";

interface LayoutValue {
  layout: ShellLayout;
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  /** A screen is showing its right dock now (not just remembered open), so a crowded window
   * can give it the second sidebar's room. Set by the dock itself. */
  rightPanelShown: boolean;
  /** Put the showing right dock away (asking for the sidebar back on a crowded window). */
  hideRightPanel(): void;
  /** The dock registers how to hide itself while it shows; undefined when it hides. */
  setRightPanel(hide: (() => void) | undefined): void;
  /** The injected key-value storage, for features that persist their own local UI state. */
  storage: KeyValueStorage | undefined;
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
      setRightPanel: (hide) => setRightPanelState(hide ? { hide } : undefined),
      storage,
      toggleSidebar: () => change((p) => ({ ...p, sidebarOpen: !p.sidebarOpen })),
      setSidebarOpen: (open) => change((p) => ({ ...p, sidebarOpen: open })),
    }),
    [layout, paletteOpen, rightPanel, change, storage],
  );
  return (
    <LayoutContext.Provider value={value}>
      <WorkspaceProvider storage={storage}>{props.children}</WorkspaceProvider>
    </LayoutContext.Provider>
  );
}

export function useLayout(): LayoutValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout needs a <LayoutProvider>");
  return value;
}
