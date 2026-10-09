import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, CSSProperties } from "react";
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
/** An imperative focus destination, read only by events that remove their own control. */
class SidebarToggleFocus {
  private node: HTMLButtonElement | null = null;
  register = (element: HTMLButtonElement | null) => {
    this.node = element;
  };
  focus = () => this.node?.focus();
}
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
const SidebarToggleContext = createContext<(element: HTMLButtonElement | null) => void>(noop);
export const useSidebarToggleRegistration = () => useContext(SidebarToggleContext);

/** The sheet: only narrow windows use it, so its code loads when one does. */
const SidebarResize = lazy(() =>
  import("./sidebar-resize.tsx").then((module) => ({ default: module.SidebarResize })),
);

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
  const { layout, setSidebarOpen, setSidebarWidth, hideRightPanel, rightPanelShown } = useLayout();
  const wide = useSidebarInline();
  const sidebar = useRef<HTMLDivElement>(null);
  const [sidebarToggle] = useState(() => new SidebarToggleFocus());
  const setSidebarToggle = sidebarToggle.register;
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
  const inline = layout.sidebarOpen && !yielded;
  useLayoutEffect(() => {
    if (inline && wide) sidebar.current?.style.removeProperty("width");
  }, [inline, wide]);
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
      bodyClaimed: claims > 0,
      claimBody,
    }),
    [shown, wide, yielded, body, claims, claimBody, setSidebarOpen, hideRightPanel],
  );
  // ⌘\ shows or hides the sidebar where it is: the sheet on a narrow window (leaving the wide
  // window's remembered choice alone), the sidebar beside the content elsewhere.
  useHotkey(keymap.toggleSidebar.keys, value.sidebarShown ? value.hideSidebar : value.showSidebar);
  return (
    <FrameContext.Provider value={value}>
      <SidebarToggleContext.Provider value={setSidebarToggle}>
        <div
          // Read by the desktop app's title bar rules: what sits under the traffic lights.
          data-sidebar={wide ? (inline ? "shown" : "hidden") : "sheet"}
          className="relative z-[1] flex min-h-0 min-w-0 flex-1"
        >
          {wide ? (
            <div
              ref={sidebar}
              style={{ "--sidebar-w": `${layout.sidebarWidth}px` } as CSSProperties}
              hidden={!presence.mounted}
              inert={presence.phase === "exit"}
              data-edge="left"
              className={cn(
                "sidebar-scroll vibrancy relative flex w-[clamp(220px,var(--sidebar-w),min(480px,40vw))] min-w-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
                panelMotion(presence),
              )}
            >
              {props.sidebar}
              {inline && (
                <Suspense fallback={null}>
                  <SidebarResize
                    sidebar={sidebar}
                    width={layout.sidebarWidth}
                    onWidth={setSidebarWidth}
                    onCollapse={() => {
                      value.hideSidebar();
                      sidebarToggle.focus();
                    }}
                  />
                </Suspense>
              )}
            </div>
          ) : (
            // Closed until asked for, so it renders nothing while its code arrives.
            <Suspense fallback={null}>
              <SidebarSheet open={sheetOpen} onOpenChange={setSheetOpen}>
                {props.sidebar}
              </SidebarSheet>
            </Suspense>
          )}
          {wide && !inline && (
            <button
              type="button"
              aria-label="Reopen sidebar"
              onClick={() => {
                value.showSidebar();
                sidebarToggle.focus();
              }}
              className="group/restore absolute inset-y-0 left-0 z-30 w-3 bg-transparent outline-none hover:bg-sidebar/80 focus-visible:bg-sidebar [-webkit-app-region:no-drag]"
            >
              <span className="absolute top-1/2 left-0 grid size-7 -translate-y-1/2 place-items-center rounded-r-md bg-sidebar text-muted-foreground opacity-0 transition-opacity group-hover/restore:opacity-100 group-focus-visible/restore:opacity-100 motion-reduce:transition-none">
                <SidebarSimpleIcon aria-hidden size={16} />
              </span>
            </button>
          )}
          {props.children}
        </div>
      </SidebarToggleContext.Provider>
    </FrameContext.Provider>
  );
}
