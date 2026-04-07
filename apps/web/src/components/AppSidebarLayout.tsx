import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { resolveDesktopMenuSettingsRoute } from "../lib/desktopMenu";
import { resolveSidebarNewThreadEnvMode } from "../lib/sidebar";
import { resolveThreadCreationOptions } from "../lib/threadCreation";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const appSettings = useSettings();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      const settingsRoute = resolveDesktopMenuSettingsRoute(action);
      if (settingsRoute) {
        void navigate({ to: settingsRoute });
        return;
      }

      if (action !== "new-thread" && action !== "new-local-thread") {
        return;
      }

      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId;
      if (!projectId) {
        return;
      }

      void handleNewThread(
        projectId,
        resolveThreadCreationOptions(action, {
          activeDraftThread: activeDraftThread
            ? {
                branch: activeDraftThread.branch,
                envMode: activeDraftThread.envMode,
                worktreePath: activeDraftThread.worktreePath,
              }
            : null,
          activeThread: activeThread
            ? {
                branch: activeThread.branch,
                worktreePath: activeThread.worktreePath,
              }
            : null,
          defaultNewThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
        }),
      );
    });

    return () => {
      unsubscribe?.();
    };
  }, [
    activeDraftThread,
    activeThread,
    appSettings.defaultThreadEnvMode,
    defaultProjectId,
    handleNewThread,
    navigate,
  ]);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        onClickCapture={(event) => {
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (!target?.closest("button,a,[role='button'],[data-slot='sidebar-menu-button']")) {
            return;
          }
          window.dispatchEvent(new CustomEvent("ace:sidebar-interaction"));
        }}
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  );
}
