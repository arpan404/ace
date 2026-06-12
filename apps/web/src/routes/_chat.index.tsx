import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { AppPageTopBar } from "../components/AppPageTopBar";
import { SidebarInset } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSetting } from "../hooks/useSettings";

function ChatIndexRouteView() {
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const defaultThreadEnvMode = useSetting("defaultThreadEnvMode");

  useEffect(() => {
    if (defaultProjectId === null) {
      return;
    }
    void handleNewThread(defaultProjectId, {
      envMode: defaultThreadEnvMode,
      replace: true,
    });
  }, [defaultProjectId, defaultThreadEnvMode, handleNewThread]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative flex shrink-0 items-stretch overflow-hidden bg-background">
          <AppPageTopBar className="min-w-0 flex-1">
            <div className="min-w-0 flex-1" />
          </AppPageTopBar>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
