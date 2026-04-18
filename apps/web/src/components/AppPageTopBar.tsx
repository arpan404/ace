import type { ReactNode } from "react";

import { isElectron } from "../env";
import {
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "../lib/desktopChrome";
import { cn } from "../lib/utils";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";

interface AppPageTopBarProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
}

export function AppPageTopBar({ children, className, contentClassName }: AppPageTopBarProps) {
  const { state: sidebarState } = useSidebar();

  return (
    <header
      className={cn(
        "relative z-30 w-full shrink-0 border-b border-sidebar-border bg-sidebar",
        isElectron
          ? "drag-region flex min-h-[52px] items-center px-4 sm:px-6"
          : "px-4 py-3 sm:px-6 sm:py-3.5",
        className,
      )}
      style={isElectron && sidebarState === "collapsed" ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined}
    >
      <div className={cn("flex min-w-0 flex-1 items-center gap-2.5", contentClassName)}>
        <SidebarTrigger className={cn("shrink-0", DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME)} />
        {children}
      </div>
    </header>
  );
}
