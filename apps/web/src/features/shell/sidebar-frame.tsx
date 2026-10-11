import { useRouterState } from "@tanstack/react-router";
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode, CSSProperties } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { crowdedQuery, overlayPanelsQuery, useSidebarInline } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar.tsx";

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
 * The one sidebar (280px, translucent) and the selected view beside it. ⌘\ hides and shows the
 * sidebar. Below 768px it is a sheet opened from the header. Below 1100px it steps aside while
 * the screen's right panel is open, so the panel can dock beside the column, and comes back when
 * it closes; where panels float anyway (896px and below) it stays put. It stays mounted for the
 * app's life; Home and Settings draw their list into its body.
 */
export function SidebarFrame(props: { sidebar: ReactNode; children: ReactNode }) {
  const { layout, setSidebarOpen, hideRightPanel, rightPanelShown } = useLayout();
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
  return (
    <FrameContext.Provider value={value}>
      <SidebarProvider
        open={inline}
        onOpenChange={(open) => (open ? value.showSidebar() : value.hideSidebar())}
        isMobile={!wide}
        openMobile={sheetOpen}
        onOpenMobileChange={setSheetOpen}
        style={{ "--sidebar-width": "280px" } as CSSProperties}
        data-sidebar={wide ? (inline ? "shown" : "hidden") : "sheet"}
        className="relative z-[1]"
      >
        {setup ? null : wide ? (
          <Sidebar>{props.sidebar}</Sidebar>
        ) : (
          <Suspense fallback={null}>
            <SidebarSheet open={sheetOpen} onOpenChange={setSheetOpen}>
              {props.sidebar}
            </SidebarSheet>
          </Suspense>
        )}
        {props.children}
      </SidebarProvider>
    </FrameContext.Provider>
  );
}
