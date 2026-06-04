import { Undo2Icon } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppPageTopBar } from "../AppPageTopBar";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { getSettingsNavItem } from "./settingsNavigation";
import { useSettingsRestore } from "./useSettingsRestore";

export function SettingsRouteLayout() {
  const navigate = useNavigate();
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
        void navigate({ to: "/", replace: true });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigate]);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <AppPageTopBar className="border-border/35 bg-sidebar/96">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <h1 className="min-w-0 shrink truncate text-[13px] leading-none font-semibold tracking-tight text-foreground">
                Settings
              </h1>
              <span className="shrink-0 text-[12px] leading-none font-medium text-muted-foreground/52">
                &gt;
              </span>
              <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground/72">
                <span className="min-w-0 truncate text-[12px] leading-none font-medium">
                  {currentItem.label}
                </span>
              </div>
            </div>
            <Button
              size="default"
              variant="ghost"
              disabled={changedSettingLabels.length === 0}
              onClick={() => void restoreDefaults()}
              className="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]/none font-medium text-muted-foreground/78 shadow-none hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.08] disabled:text-muted-foreground/35 disabled:hover:bg-transparent"
            >
              <Undo2Icon className="size-3.5" />
              Reset
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
