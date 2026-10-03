import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/**
 * Shell layout: the second sidebar, the right panel (Changes · Preview · Agents) and the
 * bottom panel (Terminal · Logs). Local UI state, not server state, so plain React state
 * persisted to storage; sizes and open panels survive reloads.
 */
const PanelState = z.object({ open: z.boolean(), tab: z.string().min(1), size: z.number() });
export type PanelState = z.infer<typeof PanelState>;
export const ShellLayout = z.object({
  sidebarOpen: z.boolean().catch(true),
  right: PanelState.catch({ open: false, tab: "changes", size: 500 }),
  bottom: PanelState.catch({ open: false, tab: "terminal", size: 240 }),
});
export type ShellLayout = z.infer<typeof ShellLayout>;
export type PanelSide = "right" | "bottom";

const defaultLayout: ShellLayout = {
  sidebarOpen: true,
  right: { open: false, tab: "changes", size: 500 },
  bottom: { open: false, tab: "terminal", size: 240 },
};
const storageKey = "ace.layout";

interface LayoutValue {
  layout: ShellLayout;
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;
  setPanelOpen(side: PanelSide, open: boolean): void;
  togglePanel(side: PanelSide): void;
  /** Show a tab; if that tab is already showing, close the panel (⌘J twice). */
  toggleTab(side: PanelSide, tab: string): void;
  setTab(side: PanelSide, tab: string): void;
  /** Live size while dragging; `persist` once the drag ends. */
  setPanelSize(side: PanelSide, size: number, persist?: boolean): void;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
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
  const change = useCallback(
    (next: (previous: ShellLayout) => ShellLayout, persist = true) =>
      setLayout((previous) => {
        const value = next(previous);
        if (persist) writeJson(storage, storageKey, value);
        return value;
      }),
    [storage],
  );
  const value = useMemo<LayoutValue>(() => {
    const panel = (side: PanelSide, patch: (p: PanelState) => PanelState, persist = true) =>
      change((previous) => ({ ...previous, [side]: patch(previous[side]) }), persist);
    return {
      layout,
      paletteOpen,
      setPaletteOpen,
      toggleSidebar: () => change((p) => ({ ...p, sidebarOpen: !p.sidebarOpen })),
      setSidebarOpen: (open) => change((p) => ({ ...p, sidebarOpen: open })),
      setPanelOpen: (side, open) => panel(side, (p) => ({ ...p, open })),
      togglePanel: (side) => panel(side, (p) => ({ ...p, open: !p.open })),
      toggleTab: (side, tab) =>
        panel(side, (p) =>
          p.open && p.tab === tab ? { ...p, open: false } : { ...p, open: true, tab },
        ),
      setTab: (side, tab) => panel(side, (p) => ({ ...p, tab })),
      setPanelSize: (side, size, persist = false) => panel(side, (p) => ({ ...p, size }), persist),
    };
  }, [layout, paletteOpen, change]);
  return <LayoutContext.Provider value={value}>{props.children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout needs a <LayoutProvider>");
  return value;
}
