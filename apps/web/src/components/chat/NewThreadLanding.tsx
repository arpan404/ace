import { type ProjectId } from "@ace/contracts";
import { ArrowRightIcon, HammerIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useSetting } from "~/hooks/useSettings";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";
import { useStore } from "~/store";

import { AppPageTopBar } from "../AppPageTopBar";
import { Button } from "../ui/button";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";

export function NewThreadLanding() {
  const projects = useStore((store) => store.projects);
  const activeProjects = useMemo(
    () => projects.filter((project) => project.archivedAt === null),
    [projects],
  );
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const defaultThreadEnvMode = useSetting("defaultThreadEnvMode");
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
        defaultEnvMode: defaultThreadEnvMode,
      }),
    );
  }, [activeProjectId, defaultThreadEnvMode, handleNewThread]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <AppPageTopBar>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Start
            </span>
            <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              New thread
            </span>
          </div>
          {activeProject ? (
            <span className="max-w-52 shrink-0 truncate text-[12px] font-medium text-muted-foreground">
              {activeProject.name}
            </span>
          ) : null}
        </div>
      </AppPageTopBar>

      <div className="relative flex flex-1 items-center justify-center overflow-x-hidden overflow-y-auto px-5 py-10 sm:px-10 sm:py-12">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 bg-muted/5" />
        </div>

        <section className="relative flex w-full max-w-2xl flex-col items-center text-center">
          <div className="mb-6 sm:mb-8">
            <HammerIcon className="size-9 text-foreground/60 sm:size-10" aria-hidden="true" />
          </div>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            Let's build
          </h1>

          {hasProjects ? (
            <>
              <ProjectContextSwitcher
                activeProjectId={activeProjectId}
                className="mt-4 max-w-full"
                onSelectProject={setSelectedProjectId}
                variant="hero"
              />
              <div className="mt-7 flex w-full flex-wrap items-center justify-center gap-3 sm:mt-8">
                <Button
                  size="lg"
                  onClick={startNewThread}
                  className="h-10.5 w-full rounded-[var(--control-radius)] px-4.5 text-sm sm:h-11 sm:w-auto sm:px-5"
                >
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
              <div className="mt-8 inline-flex items-center gap-2 rounded-[var(--control-radius)] border border-dashed border-border/50 bg-muted/20 px-4 py-2.5 text-sm text-muted-foreground">
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
