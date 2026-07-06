import type { ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { AnimatePresence, m } from "motion/react";

import { isElectron } from "../env";
import {
  DESKTOP_HEADER_CHROME_CLASS_NAME,
  DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME,
  DESKTOP_HEADER_NAV_CLUSTER_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "../lib/desktopChrome";
import { APP_HEADER_CLASS_NAME } from "../lib/appChrome";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface AppPageTopBarProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly desktopDragRegion?: boolean;
  readonly showSidebarTrigger?: boolean;
}

const headerNavIconClassName =
  "size-[19px] opacity-72 transition-opacity duration-150 group-hover/sidebar-nav-button:opacity-100";

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
          "pl-2",
          contentClassName,
        )}
      >
        <AnimatePresence initial={false}>
          {showHeaderSidebarTrigger ? (
            <m.div
              key="collapsed-sidebar-nav"
              className={DESKTOP_HEADER_NAV_CLUSTER_CLASS_NAME}
              initial={{ opacity: 0, x: -10, scale: 0.96, width: 34 }}
              animate={{ opacity: 1, x: 0, scale: 1, width: "auto" }}
              exit={{ opacity: 0, x: -8, scale: 0.97, width: 34 }}
              transition={{
                type: "spring",
                stiffness: 520,
                damping: 42,
                mass: 0.72,
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={<SidebarTrigger className={DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME} />}
                />
                <TooltipPopup side="bottom" sideOffset={4}>
                  Toggle sidebar
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME}
                      aria-label="Go back"
                      onClick={() => window.history.back()}
                    >
                      <ArrowLeftIcon className={headerNavIconClassName} strokeWidth={2.25} />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom" sideOffset={4}>
                  Back
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME}
                      aria-label="Go forward"
                      onClick={() => window.history.forward()}
                    >
                      <ArrowRightIcon className={headerNavIconClassName} strokeWidth={2.25} />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom" sideOffset={4}>
                  Forward
                </TooltipPopup>
              </Tooltip>
            </m.div>
          ) : null}
        </AnimatePresence>
        {children}
      </div>
    </header>
  );
}
