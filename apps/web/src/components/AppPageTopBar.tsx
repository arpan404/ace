import type { ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { isElectron } from "../env";
import {
  DESKTOP_HEADER_CHROME_CLASS_NAME,
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "../lib/desktopChrome";
import { APP_HEADER_CLASS_NAME, APP_INTERACTIVE_HOVER_CLASS_NAME } from "../lib/appChrome";
import { cn } from "../lib/utils";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface AppPageTopBarProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly desktopDragRegion?: boolean;
  readonly showSidebarTrigger?: boolean;
}

const headerNavButtonClassName = cn(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[var(--chip-radius)] text-sidebar-foreground/65 outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
  APP_INTERACTIVE_HOVER_CLASS_NAME,
);

export function AppPageTopBar({
  children,
  className,
  contentClassName,
  desktopDragRegion = true,
  showSidebarTrigger = true,
}: AppPageTopBarProps) {
  const { isMobile, state: sidebarState } = useSidebar();
  const showHeaderSidebarTrigger = showSidebarTrigger && (isMobile || sidebarState === "collapsed");

  return (
    <header
      className={cn(
        "relative z-30 w-full shrink-0",
        APP_HEADER_CLASS_NAME,
        isElectron
          ? cn(
              desktopDragRegion ? "drag-region" : "[-webkit-app-region:no-drag]",
              "flex min-h-[44px] items-center",
              DESKTOP_HEADER_CHROME_CLASS_NAME,
            )
          : DESKTOP_HEADER_CHROME_CLASS_NAME,
        className,
      )}
      style={isElectron && sidebarState === "collapsed" ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 transition-[padding] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:gap-2",
          showHeaderSidebarTrigger ? "pl-1.5" : "pl-0",
          contentClassName,
        )}
      >
        {showHeaderSidebarTrigger ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={headerNavButtonClassName}
                    aria-label="Go back"
                    onClick={() => window.history.back()}
                  >
                    <ChevronLeftIcon className="size-4.5" strokeWidth={2.25} />
                  </button>
                }
              />
              <TooltipPopup side="bottom" sideOffset={4}>
                Back
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={headerNavButtonClassName}
                    aria-label="Go forward"
                    onClick={() => window.history.forward()}
                  >
                    <ChevronRightIcon className="size-4.5" strokeWidth={2.25} />
                  </button>
                }
              />
              <TooltipPopup side="bottom" sideOffset={4}>
                Forward
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {children}
        {showHeaderSidebarTrigger ? (
          <SidebarTrigger className={cn("shrink-0", DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME)} />
        ) : null}
      </div>
    </header>
  );
}
