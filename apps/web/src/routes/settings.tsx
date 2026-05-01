import { RotateCcwIcon } from "lucide-react";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppPageTopBar } from "../components/AppPageTopBar";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { getSettingsNavItem } from "../components/settings/settingsNavigation";
import { HEADER_PILL_CONTROL_CLASS_NAME, TopBarCluster } from "../components/thread/TopBarCluster";
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
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <h1 className="min-w-0 shrink truncate text-[13px] leading-none font-semibold tracking-tight text-foreground">
                Settings
              </h1>
              <span className="h-3.5 w-px shrink-0 bg-border/70" aria-hidden="true" />
              <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground/72">
                {currentItem.icon ? <currentItem.icon className="size-3.5 shrink-0" /> : null}
                <span className="min-w-0 truncate text-[12px] leading-none font-medium">
                  {currentItem.label}
                </span>
              </div>
            </div>
            <TopBarCluster className="shrink-0">
              <Button
                size="default"
                variant="ghost"
                disabled={changedSettingLabels.length === 0}
                onClick={() => void restoreDefaults()}
                className={HEADER_PILL_CONTROL_CLASS_NAME}
              >
                <RotateCcwIcon className="size-3.5" />
                Restore defaults
              </Button>
            </TopBarCluster>
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
