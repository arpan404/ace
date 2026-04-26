import type { ReactNode } from "react";

import { isElectron } from "../env";
import {
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "../lib/desktopChrome";
import { cn } from "../lib/utils";
import { HEADER_PILL_ICON_TRIGGER_CLASS_NAME } from "./thread/TopBarCluster";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";

interface AppPageTopBarProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly showSidebarTrigger?: boolean;
}

export function AppPageTopBar({
  children,
  className,
  contentClassName,
  showSidebarTrigger = true,
}: AppPageTopBarProps) {
  const { isMobile, state: sidebarState } = useSidebar();
  const showHeaderSidebarTrigger = showSidebarTrigger && (isMobile || sidebarState === "collapsed");

  return (
    <header
      className={cn(
        "relative z-30 w-full shrink-0 bg-sidebar",
        isElectron
          ? "drag-region flex min-h-[48px] items-center px-3.5 sm:px-6"
          : "px-3.5 py-1.5 sm:px-6 sm:py-2",
        className,
      )}
      style={isElectron && sidebarState === "collapsed" ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 transition-[padding] duration-200 ease-out sm:gap-2",
          showHeaderSidebarTrigger ? "pl-2 sm:pl-2.5" : "pl-0",
          contentClassName,
        )}
      >
        {showHeaderSidebarTrigger ? (
          <SidebarTrigger
            className={cn(
              "shrink-0",
              DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
              HEADER_PILL_ICON_TRIGGER_CLASS_NAME,
            )}
          />
        ) : null}
        {children}
      </div>
    </header>
  );
}
