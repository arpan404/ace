import { useRouterState } from "@tanstack/react-router";
import { createContext, lazy, Suspense, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { crowdedQuery, overlayPanelsQuery, useSidebarInline } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { panelMotion, usePresence } from "@/lib/motion.ts";
import { cn } from "@/lib/cn.ts";

interface FrameValue {
  /** There is a sidebar (the header shows its toggle). */
  hasSidebar: boolean;
  /** The rail and sidebar are a sheet over the content (narrow windows), not beside it. */
  sheet: boolean;
  /** The sidebar is on screen. */
  sidebarShown: boolean;
  showSidebar(): void;
  hideSidebar(): void;
  /** Where the current view puts its own list (`ViewFrame`); null while none is drawn. */
  body: HTMLElement | null;
  setBody(element: HTMLElement | null): void;
}
const noop = () => {};
const FrameContext = createContext<FrameValue>({
  hasSidebar: false,
  sheet: false,
  sidebarShown: false,
  showSidebar: noop,
  hideSidebar: noop,
  body: null,
  setBody: noop,
});
export const useViewFrame = () => useContext(FrameContext);

/** The sheet: only narrow windows use it, so its code loads when one does. */
const SidebarSheet = lazy(() =>
  import("./sidebar-sheet.tsx").then((module) => ({ default: module.SidebarSheet })),
);

/**
 * The rail of views, the sidebar beside it (280px, translucent) and the selected view. ⌘\
 * hides and shows the sidebar; the rail always stays. Below 768px both are a sheet opened from
 * the header. Below 1100px the sidebar steps aside while the screen's right panel is open, so
 * the panel can dock beside the column, and comes back when it closes; where panels float
 * anyway (896px and below) it stays put. Both stay mounted for the app's life; each view draws its own list
 * into the sidebar's body.
 */
export function SidebarFrame(props: { rail: ReactNode; sidebar: ReactNode; children: ReactNode }) {
  const { layout, setSidebarOpen, hideRightPanel, rightPanelShown } = useLayout();
  const wide = useSidebarInline();
  const crowded = useMediaQuery(crowdedQuery, false);
  const overlay = useMediaQuery(overlayPanelsQuery, false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [body, setBody] = useState<HTMLElement | null>(null);
  // The sheet is a way to get somewhere: it closes once the person has gone there.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setSheetOpen(false);
  }
  // Yielding is not remembered: the person's own choice (sidebarOpen) is what comes back.
  const yielded = crowded && !overlay && rightPanelShown;
  const inline = layout.sidebarOpen && !yielded;
  const shown = wide ? inline : sheetOpen;
  // The sidebar stays mounted while hidden (it keeps its scroll and state); it slides in from
  // the left when shown and fades before the column takes its space back when hidden.
  const presence = usePresence(inline);
  const value = useMemo<FrameValue>(
    () => ({
      hasSidebar: true,
      sheet: !wide,
      sidebarShown: shown,
      showSidebar: () => {
        if (!wide) return setSheetOpen(true);
        // Asking for the sidebar back on a crowded window puts the right panel away.
        if (yielded) hideRightPanel();
        setSidebarOpen(true);
      },
      hideSidebar: () => (wide ? setSidebarOpen(false) : setSheetOpen(false)),
      body,
      setBody,
    }),
    [shown, wide, yielded, body, setSidebarOpen, hideRightPanel],
  );
  // ⌘\ shows or hides the sidebar where it is: the sheet on a narrow window (leaving the wide
  // window's remembered choice alone), the sidebar beside the rail elsewhere.
  useHotkey(keymap.toggleSidebar.keys, value.sidebarShown ? value.hideSidebar : value.showSidebar);
  return (
    <FrameContext.Provider value={value}>
      <div
        // Read by the desktop app's title bar rules: what sits under the traffic lights.
        data-sidebar={wide ? (inline ? "shown" : "hidden") : "sheet"}
        className="relative z-[1] flex min-h-0 min-w-0 flex-1"
      >
        {wide ? (
          <>
            {props.rail}
            <div
              hidden={!presence.mounted}
              inert={presence.phase === "exit"}
              data-edge="left"
              className={cn(
                "vibrancy flex w-(--sidebar-w) min-w-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
                panelMotion(presence),
              )}
            >
              {props.sidebar}
            </div>
          </>
        ) : (
          // Closed until asked for, so it renders nothing while its code arrives.
          <Suspense fallback={null}>
            <SidebarSheet open={sheetOpen} onOpenChange={setSheetOpen} rail={props.rail}>
              {props.sidebar}
            </SidebarSheet>
          </Suspense>
        )}
        {props.children}
      </div>
    </FrameContext.Provider>
  );
}
