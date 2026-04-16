import { RotateCcwIcon } from "lucide-react";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { getSettingsNavItem } from "../components/settings/settingsNavigation";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger, useSidebar } from "../components/ui/sidebar";
import { isElectron } from "../env";
import {
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "../lib/desktopChrome";
import { cn } from "../lib/utils";

function SettingsContentLayout() {
  const { isMobile, state: sidebarState } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  const currentItem = getSettingsNavItem(pathname);
  const showSidebarToggle = !isElectron || isMobile || sidebarState === "collapsed";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        window.history.back();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "relative z-30 w-full shrink-0 border-b border-sidebar-border bg-sidebar",
            isElectron
              ? "drag-region flex min-h-[52px] items-center px-4 sm:px-6"
              : "px-4 py-3 sm:px-6 sm:py-3.5",
          )}
          style={
            isElectron && sidebarState === "collapsed" ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined
          }
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {showSidebarToggle ? (
              <SidebarTrigger className={cn("shrink-0", DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME)} />
            ) : null}
            <h1 className="min-w-0 flex-1 truncate text-[13px] leading-none font-medium tracking-tight text-foreground/80">
              {currentItem.label}
            </h1>
            <Button
              size="xs"
              variant="outline"
              disabled={changedSettingLabels.length === 0}
              onClick={() => void restoreDefaults()}
              className="shrink-0"
            >
              <RotateCcwIcon className="size-3.5" />
              Restore defaults
            </Button>
          </div>
        </header>

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
