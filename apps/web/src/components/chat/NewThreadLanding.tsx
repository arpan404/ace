import { type ProjectId } from "@ace/contracts";
import { ArrowRightIcon, HammerIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "~/env";
import {
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "~/lib/desktopChrome";
import { cn } from "~/lib/utils";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useSettings } from "~/hooks/useSettings";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";
import { useStore } from "~/store";

import { Button } from "../ui/button";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";

export function NewThreadLanding() {
  const { isMobile, state: sidebarState } = useSidebar();
  const projects = useStore((store) => store.projects);
  const activeProjects = useMemo(
    () => projects.filter((project) => project.archivedAt === null),
    [projects],
  );
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const settings = useSettings();
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(defaultProjectId);
  const activeProjectId = useMemo(() => {
    if (
      selectedProjectId !== null &&
      activeProjects.some((project) => project.id === selectedProjectId)
    ) {
      return selectedProjectId;
    }
    return defaultProjectId;
  }, [activeProjects, defaultProjectId, selectedProjectId]);
  const activeProject = useMemo(
    () => activeProjects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, activeProjects],
  );
  const hasProjects = activeProjects.length > 0;
  const showSidebarToggle = !isElectron || isMobile || sidebarState === "collapsed";
  const startNewThread = useCallback(() => {
    if (activeProjectId === null) {
      return;
    }
    void handleNewThread(
      activeProjectId,
      resolveSidebarNewThreadOptions({
        projectId: activeProjectId,
        defaultEnvMode: settings.defaultThreadEnvMode,
      }),
    );
  }, [activeProjectId, handleNewThread, settings.defaultThreadEnvMode]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      {!isElectron && (
        <header
          className={cn(
            "relative z-30 w-full shrink-0 border-b border-sidebar-border bg-sidebar",
            "px-4 py-3 sm:px-6 sm:py-3.5",
          )}
        >
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              {showSidebarToggle ? (
                <SidebarTrigger className={DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME} />
              ) : null}
              <div className="flex min-w-0 items-baseline gap-2.5">
                <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  Start
                </span>
                <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                  New thread
                </span>
              </div>
            </div>
            {activeProject ? (
              <span className="max-w-52 shrink-0 truncate text-[12px] font-medium text-muted-foreground">
                {activeProject.name}
              </span>
            ) : null}
          </div>
        </header>
      )}

      {isElectron && (
        <header
          className={cn(
            "relative z-30 w-full shrink-0 border-b border-sidebar-border bg-sidebar",
            "drag-region flex min-h-[52px] items-center px-4 sm:px-6",
          )}
          style={sidebarState === "collapsed" ? MAC_TITLEBAR_LEFT_INSET_STYLE : undefined}
        >
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              {!isMobile && sidebarState === "collapsed" ? (
                <SidebarTrigger className={DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME} />
              ) : null}
              <div className="flex min-w-0 items-baseline gap-2.5">
                <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  Start
                </span>
                <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                  New thread
                </span>
              </div>
            </div>
            {activeProject ? (
              <span className="max-w-52 shrink-0 truncate text-[12px] font-medium text-muted-foreground">
                {activeProject.name}
              </span>
            ) : null}
          </div>
        </header>
      )}

      <div className="relative flex flex-1 items-center justify-center overflow-x-hidden overflow-y-auto px-6 py-12 sm:px-10">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 bg-muted/5" />
        </div>

        <section className="relative flex w-full max-w-2xl flex-col items-center text-center">
          <div className="mb-8">
            <HammerIcon className="size-10 text-foreground/60" aria-hidden="true" />
          </div>
          <h1 className="text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
            Let's build
          </h1>

          {hasProjects ? (
            <>
              <ProjectContextSwitcher
                activeProjectId={activeProjectId}
                className="mt-4"
                onSelectProject={setSelectedProjectId}
                variant="hero"
              />
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button size="lg" onClick={startNewThread}>
                  Start new thread
                  <ArrowRightIcon className="size-4.5" />
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-5 max-w-lg text-sm leading-relaxed text-muted-foreground/65">
                Add a project from the sidebar to get started. Once a project is available, new
                threads open with visible project context and a quick switcher.
              </p>
              <div className="mt-8 inline-flex items-center gap-2 rounded-md border border-dashed border-border/50 bg-muted/20 px-4 py-2.5 text-sm text-muted-foreground">
                <PlusIcon className="size-4" />
                Use the Add project button in the sidebar.
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
