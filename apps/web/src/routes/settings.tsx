import { RotateCcwIcon } from "lucide-react";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppPageTopBar } from "../components/AppPageTopBar";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { getSettingsNavItem } from "../components/settings/settingsNavigation";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";

function SettingsContentLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  const currentItem = getSettingsNavItem(pathname);

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
        <AppPageTopBar>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
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
        </AppPageTopBar>

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
