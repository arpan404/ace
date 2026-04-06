import { RotateCcwIcon } from "lucide-react";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { getSettingsNavItem } from "../components/settings/settingsNavigation";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";

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
        {!isElectron && (
          <header className="border-b border-border px-3 py-3 sm:px-5">
            <div className="flex flex-wrap items-start gap-3 sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <SidebarTrigger className="mt-0.5 size-7 shrink-0 md:hidden" />
                <div className="min-w-0">
                  <p className="text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
                    Settings
                  </p>
                  <h1 className="truncate text-sm font-semibold text-foreground sm:text-base">
                    {currentItem.label}
                  </h1>
                  <p className="mt-0.5 hidden max-w-2xl text-xs text-muted-foreground sm:block">
                    {currentItem.description}
                  </p>
                </div>
              </div>
              <div className="ms-auto flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={changedSettingLabels.length === 0}
                  onClick={() => void restoreDefaults()}
                >
                  <RotateCcwIcon className="size-3.5" />
                  Restore defaults
                </Button>
              </div>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex min-h-[52px] shrink-0 items-center border-b border-border px-5 py-2">
            <div className="min-w-0">
              <p className="text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase">
                Settings
              </p>
              <p className="truncate text-xs font-semibold tracking-wide text-foreground">
                {currentItem.label}
              </p>
            </div>
            <div className="ms-auto flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={changedSettingLabels.length === 0}
                onClick={() => void restoreDefaults()}
              >
                <RotateCcwIcon className="size-3.5" />
                Restore defaults
              </Button>
            </div>
          </div>
        )}

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
