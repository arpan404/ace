import { useRouterState } from "@tanstack/react-router";
import { createContext, lazy, Suspense, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { crowdedQuery, useSidebarInline } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { panelMotion, usePresence } from "@/lib/motion.ts";
import { cn } from "@/lib/cn.ts";

interface FrameValue {
  /** There is a sidebar (the header shows its toggle). */
  hasSidebar: boolean;
  /** The sidebar is a sheet over the content (narrow windows), not beside it. */
  sheet: boolean;
  /** The sidebar is on screen, full or as icons. */
  sidebarShown: boolean;
  /** Beside the content as a narrow column of icons. */
  collapsed: boolean;
  showSidebar(): void;
  hideSidebar(): void;
  collapseSidebar(): void;
  expandSidebar(): void;
  /** Where the current view puts its own list (`ViewFrame`); null while none is drawn. */
  body: HTMLElement | null;
  setBody(element: HTMLElement | null): void;
}
const noop = () => {};
const FrameContext = createContext<FrameValue>({
  hasSidebar: false,
  sheet: false,
  sidebarShown: false,
  collapsed: false,
  showSidebar: noop,
  hideSidebar: noop,
  collapseSidebar: noop,
  expandSidebar: noop,
  body: null,
  setBody: noop,
});
export const useViewFrame = () => useContext(FrameContext);

/** The sidebar as a sheet: only narrow windows use it, so its code loads when one does. */
const SidebarSheet = lazy(() =>
  import("./sidebar-sheet.tsx").then((module) => ({ default: module.SidebarSheet })),
);

/**
 * The one sidebar and the selected view beside it. 296px and translucent; a column of icons
 * when collapsed; hidden with ⌘\. Below 768px it is a sheet opened from the header. Below 1100px
 * it steps down to icons while the screen's right panel is open and comes back when it closes.
 * The sidebar stays mounted for the app's life; each view draws its own list into its body.
 */
export function SidebarFrame(props: { sidebar: ReactNode; children: ReactNode }) {
  const { layout, setSidebarOpen, setSidebarCollapsed, hideRightPanel, rightPanelShown } =
    useLayout();
  const wide = useSidebarInline();
  const crowded = useMediaQuery(crowdedQuery, false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [body, setBody] = useState<HTMLElement | null>(null);
  // The sheet is a way to get somewhere: it closes once the person has gone there.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setSheetOpen(false);
  }
  // Yielding is not remembered: the person's own choice (sidebarCollapsed) is what comes back.
  const yielded = crowded && rightPanelShown;
  const inline = layout.sidebarOpen;
  const collapsed = wide && (layout.sidebarCollapsed || yielded);
  const shown = wide ? inline : sheetOpen;
  // The sidebar stays mounted while hidden (it keeps its scroll and state); it slides in from
  // the left when shown and fades before the column takes its space back when hidden.
  const presence = usePresence(inline);
  const value = useMemo<FrameValue>(
    () => ({
      hasSidebar: true,
      sheet: !wide,
      sidebarShown: shown,
      collapsed,
      showSidebar: () => (wide ? setSidebarOpen(true) : setSheetOpen(true)),
      hideSidebar: () => (wide ? setSidebarOpen(false) : setSheetOpen(false)),
      collapseSidebar: () => setSidebarCollapsed(true),
      expandSidebar: () => {
        // Asking for the full sidebar on a crowded window puts the right panel away.
        if (yielded) hideRightPanel();
        setSidebarCollapsed(false);
      },
      body,
      setBody,
    }),
    [shown, wide, collapsed, yielded, body, setSidebarOpen, setSidebarCollapsed, hideRightPanel],
  );
  return (
    <FrameContext.Provider value={value}>
      <div
        // Read by the desktop app's title bar rules: what sits under the traffic lights.
        data-sidebar={wide && inline ? (collapsed ? "collapsed" : "expanded") : "hidden"}
        className="relative z-[1] flex min-h-0 min-w-0 flex-1"
      >
        {wide ? (
          <div
            hidden={!presence.mounted}
            inert={presence.phase === "exit"}
            data-edge="left"
            className={cn(
              "vibrancy flex min-w-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
              collapsed ? "w-(--sidebar-icons-w) items-center" : "w-(--sidebar-w)",
              panelMotion(presence),
            )}
          >
            {props.sidebar}
          </div>
        ) : (
          // Closed until asked for, so it renders nothing while its code arrives.
          <Suspense fallback={null}>
            <SidebarSheet open={sheetOpen} onOpenChange={setSheetOpen}>
              {props.sidebar}
            </SidebarSheet>
          </Suspense>
        )}
        {props.children}
      </div>
    </FrameContext.Provider>
  );
}
