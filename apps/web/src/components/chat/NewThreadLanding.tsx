import { type ProjectId } from "@ace/contracts";
import { ArrowRightIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useSettings } from "~/hooks/useSettings";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";
import { useStore } from "~/store";

import { Button } from "../ui/button";
import { SidebarTrigger } from "../ui/sidebar";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";

export function NewThreadLanding() {
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
            "relative z-30 w-full shrink-0 border-b border-border bg-background",
            "px-4 py-3 sm:px-6 sm:py-3.5",
          )}
        >
          <div className="flex items-start gap-3">
            <SidebarTrigger className="size-9 shrink-0 rounded-xl border border-border bg-muted/60 md:hidden [&_svg]:size-4" />
            <div className="min-w-0">
              <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                Start
              </p>
              <p className="mt-1 text-[15px] font-semibold tracking-tight text-foreground sm:text-base">
                New thread
              </p>
            </div>
          </div>
        </header>
      )}

      {isElectron && (
        <div
          className={cn(
            "drag-region flex min-h-[52px] shrink-0 items-center justify-between border-b border-border bg-background",
            "px-5",
          )}
        >
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Start
            </span>
            <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              New thread
            </span>
          </div>
          {activeProject ? (
            <span className="max-w-52 truncate text-[12px] font-medium text-muted-foreground">
              {activeProject.name}
            </span>
          ) : null}
        </div>
      )}

      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-6 py-12 sm:px-10">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 bg-muted/5" />
        </div>

        <section className="relative flex w-full max-w-2xl flex-col items-center text-center">
          <div className="mb-7 inline-flex size-14 items-center justify-center rounded-xl border border-border/50 bg-muted/50">
            <SquarePenIcon className="size-6 text-muted-foreground" />
          </div>
          <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/60 uppercase">
            Thread context
          </p>
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
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
              <p className="mt-6 max-w-lg text-sm leading-relaxed text-muted-foreground/65">
                Start from the right project, keep the sidebar in view, and let each new draft
                thread inherit the workspace context you actually want.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button size="lg" onClick={startNewThread}>
                  Start new thread
                  <ArrowRightIcon className="size-4.5" />
                </Button>
                <div className="rounded-md bg-muted/60 px-3.5 py-1.5 text-xs text-muted-foreground">
                  {activeProjects.length} {activeProjects.length === 1 ? "project" : "projects"} in
                  {" sidebar"}
                </div>
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
