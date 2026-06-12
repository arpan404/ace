import { Undo2Icon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { SettingsContentHeader } from "./SettingsContentHeader";
import { getSettingsNavItem } from "./settingsNavigation";
import { SettingsPageProvider, SETTINGS_RESTORED_EVENT } from "./settingsPageContext";
import { useSettingsRestore } from "./useSettingsRestore";
import { SETTINGS_SHELL_CLASS } from "./settingsUi";

export function SettingsRouteLayout() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  const currentItem = getSettingsNavItem(pathname);
  const isNestedSettingsPage = pathname.startsWith("/settings/project-environment/");

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

  useEffect(() => {
    const onRestored = () => {
      setRestoreSignal((value) => value + 1);
    };
    window.addEventListener(SETTINGS_RESTORED_EVENT, onRestored);
    return () => {
      window.removeEventListener(SETTINGS_RESTORED_EVENT, onRestored);
    };
  }, []);

  const resetAction =
    changedSettingLabels.length > 0 ? (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => void restoreDefaults()}
        className="h-8 gap-1.5 px-3 text-[13px]"
      >
        <Undo2Icon className="size-3.5" />
        Reset changed
      </Button>
    ) : null;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none text-foreground">
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", SETTINGS_SHELL_CLASS)}>
        {!isNestedSettingsPage ? (
          <SettingsContentHeader pageLabel={currentItem.label} action={resetAction} />
        ) : null}

        <SettingsPageProvider
          value={{
            label: currentItem.label,
            description: currentItem.description,
            headerAction: resetAction,
          }}
        >
          <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </SettingsPageProvider>
      </div>
    </SidebarInset>
  );
}
