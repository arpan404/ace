import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Local layout state. Plain React state: it is not server state and needs no store.
 * Per-route layout that should survive reload or sharing (the agent panel) lives in
 * type-safe search params instead.
 */
interface LayoutValue {
  /** Off-canvas navigation on narrow screens. */
  navOpen: boolean;
  setNavOpen(open: boolean): void;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
}
const LayoutContext = createContext<LayoutValue | undefined>(undefined);

export function LayoutProvider(props: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const value = useMemo(
    () => ({ navOpen, setNavOpen, paletteOpen, setPaletteOpen }),
    [navOpen, paletteOpen],
  );
  return <LayoutContext.Provider value={value}>{props.children}</LayoutContext.Provider>;
}
export function useLayout(): LayoutValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout needs a <LayoutProvider>");
  return value;
}
