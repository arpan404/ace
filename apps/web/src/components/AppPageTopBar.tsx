import type { ReactNode } from "react";

import { isElectron } from "../env";
import {
  DESKTOP_HEADER_CHROME_CLASS_NAME,
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "../lib/desktopChrome";
import { cn } from "../lib/utils";
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
          ? cn("drag-region flex min-h-[44px] items-center", DESKTOP_HEADER_CHROME_CLASS_NAME)
          : DESKTOP_HEADER_CHROME_CLASS_NAME,
        className,
      )}
      style={isElectron && sidebarState === "collapsed" ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 transition-[padding] duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:gap-2",
          "pl-0",
          contentClassName,
        )}
      >
        {showHeaderSidebarTrigger ? (
          <SidebarTrigger className={cn("shrink-0", DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME)} />
        ) : null}
        {children}
      </div>
    </header>
  );
}
