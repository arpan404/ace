import { useRouterState } from "@tanstack/react-router";
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode, CSSProperties } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { sidebarWidths, useLayout } from "@/lib/layout.tsx";
import { ResizeHandle, clampSize } from "@/components/ui/resize-handle.tsx";
import { crowdedQuery, overlayPanelsQuery, useSidebarInline } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar.tsx";
import { RegionKeys } from "./region-keys.tsx";

interface FrameValue {
  /** There is a sidebar (the header shows its toggle). */
  hasSidebar: boolean;
  /** The sidebar is a sheet over the content (narrow windows), not beside it. */
  sheet: boolean;
  /** The sidebar is on screen. */
  sidebarShown: boolean;
  showSidebar(): void;
  hideSidebar(): void;
  /** Where a view puts its own list in the sidebar (`ViewFrame`); null while none is drawn. */
  body: HTMLElement | null;
  setBody(element: HTMLElement | null): void;
  /** Whether a view's list holds the sidebar's body, in place of the thread list. */
  bodyClaimed: boolean;
  /** A view's list takes the sidebar's body until the returned release is called. */
  claimBody(): () => void;
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
  bodyClaimed: false,
  claimBody: () => noop,
});
export const useViewFrame = () => useContext(FrameContext);

/** The sheet is lazy so the desktop shell does not eagerly load a dialog. */
const SidebarSheet = lazy(() =>
  import("./sidebar-sheet.tsx").then((module) => ({ default: module.SidebarSheet })),
);

/**
 * The one sidebar (336px by default, dragged between 220 and 480; double-click its edge resets it) and
 * the selected view beside it. ⌘\ hides and shows the sidebar. At 896px and below it is a sheet opened from the header. Below 1100px it steps aside while
 * the screen's right panel is open, so the panel can dock beside the column, and comes back when
 * it closes; where panels float anyway (896px and below) it stays put. It stays mounted for the
 * app's life; Home and Settings draw their list into its body.
 */
export function SidebarFrame(props: { sidebar: ReactNode; children: ReactNode }) {
  const { layout, setSidebarOpen, setSidebarWidth, hideRightPanel, rightPanelShown } = useLayout();
  // The width while a drag is under way; it is remembered once the drag ends.
  const [dragWidth, setDragWidth] = useState<number>();
  const width = clampSize(dragWidth ?? layout.sidebarWidth, sidebarWidths.min, sidebarWidths.max);
  const wide = useSidebarInline();
  const crowded = useMediaQuery(crowdedQuery, false);
  const overlay = useMediaQuery(overlayPanelsQuery, false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  // Counted, so one view's list leaving after the next one's arrives doesn't free the body.
  const claimBody = useCallback(() => {
    setClaims((count) => count + 1);
    return () => setClaims((count) => count - 1);
  }, []);
  // The sheet is a way to get somewhere: it closes once the person has gone there.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setSheetOpen(false);
  }
  // Yielding is not remembered: the person's own choice (sidebarOpen) is what comes back.
  const yielded = crowded && !overlay && rightPanelShown;
  const setup = pathname === "/setup";
  const inline = !setup && layout.sidebarOpen && !yielded;
  const shown = wide ? inline : sheetOpen;
  const value = useMemo<FrameValue>(
    () => ({
      hasSidebar: !setup,
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
      bodyClaimed: claims > 0,
      claimBody,
    }),
    [shown, wide, yielded, body, claims, claimBody, setSidebarOpen, hideRightPanel, setup],
  );
  // ⌘\ shows or hides the sidebar where it is: the sheet on a narrow window (leaving the wide
  // window's remembered choice alone), the sidebar beside the content elsewhere.
  useHotkey(keymap.toggleSidebar.keys, value.sidebarShown ? value.hideSidebar : value.showSidebar);
  // F6 and ⇧⌘E find the sidebar by this mark (`regions.ts`); `contents` keeps its layout.
  const region = (
    <div data-focus-region="sidebar" className="contents">
      {props.sidebar}
    </div>
  );
  return (
    <FrameContext.Provider value={value}>
      <SidebarProvider
        open={inline}
        onOpenChange={(open) => (open ? value.showSidebar() : value.hideSidebar())}
        isMobile={!wide}
        openMobile={sheetOpen}
        onOpenMobileChange={setSheetOpen}
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
        data-sidebar={wide ? (inline ? "shown" : "hidden") : "sheet"}
        className="relative z-[1]"
      >
        <RegionKeys showSidebar={value.hasSidebar && !shown ? value.showSidebar : undefined} />
        {setup ? null : wide ? (
          <Sidebar
            edge={
              <ResizeHandle
                label="Resize sidebar"
                edge="right"
                size={width}
                min={sidebarWidths.min}
                max={sidebarWidths.max}
                onResize={setDragWidth}
                onResizeEnd={(next) => {
                  setDragWidth(undefined);
                  setSidebarWidth(next);
                }}
                onReset={() => setSidebarWidth(sidebarWidths.preferred)}
                className="z-20 [-webkit-app-region:no-drag]"
              />
            }
          >
            {region}
          </Sidebar>
        ) : (
          <Suspense fallback={null}>
            <SidebarSheet open={sheetOpen} onOpenChange={setSheetOpen}>
              {region}
            </SidebarSheet>
          </Suspense>
        )}
        {props.children}
      </SidebarProvider>
    </FrameContext.Provider>
  );
}
