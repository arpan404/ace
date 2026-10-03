import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { crowdedQuery, useSidebarInline } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { panelMotion, usePresence } from "@/lib/motion.ts";
import { cn } from "@/lib/cn.ts";

interface FrameValue {
  /** The second sidebar is on screen (so the header hides its own toggle). */
  sidebarShown: boolean;
  showSidebar(): void;
  hideSidebar(): void;
}
const FrameContext = createContext<FrameValue>({
  sidebarShown: false,
  showSidebar: () => {},
  hideSidebar: () => {},
});
export const useViewFrame = () => useContext(FrameContext);

/**
 * A view: its second sidebar (296px, translucent, collapsible with ⌘\) and its main column.
 * Below 768px the sidebar becomes a sheet opened from the header. Below 1100px it steps aside
 * while the screen's right panel is open and comes back when the panel closes.
 */
export function ViewFrame(props: { label: string; sidebar: ReactNode; children: ReactNode }) {
  const { layout, setSidebarOpen, setPanelOpen, rightPanelShown } = useLayout();
  const wide = useSidebarInline();
  const crowded = useMediaQuery(crowdedQuery, false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Yielding is not remembered: the person's own choice (sidebarOpen) is what comes back.
  const yielded = crowded && rightPanelShown;
  const inline = layout.sidebarOpen && !yielded;
  const shown = wide ? inline : sheetOpen;
  // The sidebar stays mounted while hidden (it keeps its scroll and state); it slides in from
  // the left when shown and fades before the column takes its space back when hidden.
  const presence = usePresence(inline);
  const value = useMemo<FrameValue>(
    () => ({
      sidebarShown: shown,
      showSidebar: () => {
        if (!wide) return setSheetOpen(true);
        // Asking for the sidebar back on a crowded window puts the right panel away.
        if (yielded) setPanelOpen("right", false);
        setSidebarOpen(true);
      },
      hideSidebar: () => (wide ? setSidebarOpen(false) : setSheetOpen(false)),
    }),
    [shown, wide, yielded, setSidebarOpen, setPanelOpen],
  );
  return (
    <FrameContext.Provider value={value}>
      <div className="flex min-h-0 min-w-0 flex-1">
        {wide ? (
          <aside
            aria-label={props.label}
            hidden={!presence.mounted}
            inert={presence.phase === "exit"}
            data-edge="left"
            className={cn(
              "vibrancy flex w-(--sidebar-w) min-w-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
              panelMotion(presence),
            )}
          >
            {props.sidebar}
          </aside>
        ) : (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-[min(320px,85vw)] gap-0 bg-sidebar p-0"
            >
              <SheetTitle className="sr-only">{props.label}</SheetTitle>
              <aside aria-label={props.label} className="flex min-h-0 flex-1 flex-col">
                {props.sidebar}
              </aside>
            </SheetContent>
          </Sheet>
        )}
        <div className="relative flex min-w-0 flex-1 flex-col bg-reading">{props.children}</div>
      </div>
    </FrameContext.Provider>
  );
}

/** The second sidebar's header: view title, optional filter or actions, and the hide toggle. */
export function SidebarHeader(props: { title: string; actions?: ReactNode }) {
  const frame = useViewFrame();
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-1.5 pr-2.5 pl-4">
      <h2 className="min-w-0 flex-1 truncate text-md font-medium tracking-[-0.01em] text-foreground">
        {props.title}
      </h2>
      {props.actions}
      <IconButton
        icon={SidebarSimpleIcon}
        label="Hide sidebar"
        shortcut="toggleSidebar"
        onClick={frame.hideSidebar}
      />
    </div>
  );
}

/** Header plus a scrolling body: the common second-sidebar layout. */
export function ViewSidebar(props: {
  title: string;
  actions?: ReactNode;
  /** Fixed rows under the header (tabs, search). */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SidebarHeader title={props.title} actions={props.actions} />
      {props.toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{props.children}</div>
    </>
  );
}
