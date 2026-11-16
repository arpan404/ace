import { useMemo } from "react";
import { useSidebarInline } from "@/lib/breakpoints.ts";
import { useSuitOnScreen } from "../theme-provider.tsx";
import { resolveSuitLayout, type ResolvedSuitLayout } from "./suit-layout.ts";

/** The applied Suit's layout at this window's width; null when no Suit (or none of its own). */
export function useSuitLayout(): ResolvedSuitLayout | null {
  const suit = useSuitOnScreen();
  const wide = useSidebarInline();
  const layout = suit?.manifest.layout;
  return useMemo(() => resolveSuitLayout(layout, { wide }), [layout, wide]);
}
