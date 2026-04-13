import type { DesktopMenuAction } from "@ace/contracts";
import { useCallback, useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { requestInAppBrowserFromShell } from "../lib/browser/launcher";
import { useSettings } from "../hooks/useSettings";
import { resolveDesktopMenuSettingsRoute } from "../lib/desktopMenu";
import { resolveSidebarNewThreadEnvMode } from "../lib/sidebar";
import { resolveThreadCreationOptions } from "../lib/threadCreation";
import { isMacPlatform } from "../lib/utils";
import { useUiStateStore } from "../uiStateStore";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function isEditableHotkeyTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  return (
    element.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [data-lexical-editor="true"]',
    ) !== null
  );
}

function SidebarToggleHotkeyHandler() {
  const { isMobile, toggleSidebar } = useSidebar();

  useEffect(() => {
    if (isMobile) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey) {
        return;
      }
      const isMac = isMacPlatform(navigator.platform);
      const matchesToggleShortcut = isMac
        ? event.metaKey && !event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "b"
        : event.ctrlKey && !event.metaKey && event.shiftKey && event.key.toLowerCase() === "b";
      if (!matchesToggleShortcut || isEditableHotkeyTarget(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isMobile, toggleSidebar]);

  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread, routeThreadId } =
    useHandleNewThread();
  const appSettings = useSettings();
  const activeThreadId = useUiStateStore((store) => store.activeThreadId);
  const previousActiveThreadId = useUiStateStore((store) => store.previousActiveThreadId);

  const openBrowserFromShell = useCallback(
    async (action: "open" | "toggle") => {
      await requestInAppBrowserFromShell({
        routeThreadId,
        fallbackThreadId: activeThreadId ?? previousActiveThreadId,
        activeProjectId: activeThread?.projectId ?? activeDraftThread?.projectId ?? null,
        activeThread: activeThread
          ? {
              projectId: activeThread.projectId,
              branch: activeThread.branch,
              worktreePath: activeThread.worktreePath,
            }
          : null,
        activeDraftThread: activeDraftThread
          ? {
              projectId: activeDraftThread.projectId,
              branch: activeDraftThread.branch,
              worktreePath: activeDraftThread.worktreePath,
              envMode: activeDraftThread.envMode,
            }
          : null,
        defaultProjectId,
        defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
        handleNewThread,
        navigateToThread: async (threadId) => {
          await navigate({
            to: "/$threadId",
            params: { threadId },
          });
        },
        request: { action },
        onMissingProject: () => {
          toastManager.add({
            type: "error",
            title: "Add a project to open the browser",
            description: "The in-app browser opens from an active workspace thread.",
          });
        },
      });
    },
    [
      activeDraftThread,
      activeThread,
      activeThreadId,
      appSettings.defaultThreadEnvMode,
      defaultProjectId,
      handleNewThread,
      navigate,
      previousActiveThreadId,
      routeThreadId,
    ],
  );

  const handleDesktopMenuAction = useCallback(
    (action: DesktopMenuAction) => {
      const settingsRoute = resolveDesktopMenuSettingsRoute(action);
      if (settingsRoute) {
        void navigate({ to: settingsRoute });
        return;
      }

      if (action === "toggle-browser") {
        void openBrowserFromShell("toggle");
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
    },
    [
      activeDraftThread,
      activeThread,
      appSettings.defaultThreadEnvMode,
      defaultProjectId,
      handleNewThread,
      navigate,
      openBrowserFromShell,
    ],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction(handleDesktopMenuAction);

    return () => {
      unsubscribe?.();
    };
  }, [handleDesktopMenuAction]);

  return (
    <SidebarProvider defaultOpen>
      <SidebarToggleHotkeyHandler />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
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
