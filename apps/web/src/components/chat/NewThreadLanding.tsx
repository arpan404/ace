import { type ProjectId } from "@ace/contracts";
import { ArrowRightIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useSettings } from "~/hooks/useSettings";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";
import { useStore } from "~/store";

import { Button } from "../ui/button";
import { SidebarTrigger } from "../ui/sidebar";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";

export function NewThreadLanding() {
  const projects = useStore((store) => store.projects);
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const settings = useSettings();
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(defaultProjectId);
  const activeProjectId = useMemo(() => {
    if (
      selectedProjectId !== null &&
      projects.some((project) => project.id === selectedProjectId)
    ) {
      return selectedProjectId;
    }
    return defaultProjectId;
  }, [defaultProjectId, projects, selectedProjectId]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const hasProjects = projects.length > 0;
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
        <header className="border-b border-border/50 px-3 py-2.5 sm:px-5">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-[13px] font-medium text-foreground/90">New thread</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center justify-between border-b border-border/50 px-5">
          <span className="text-xs font-medium tracking-wide text-muted-foreground/60">
            New thread
          </span>
          {activeProject ? (
            <span className="max-w-52 truncate text-[11px] text-muted-foreground/48">
              {activeProject.name}
            </span>
          ) : null}
        </div>
      )}

      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-6 py-12 sm:px-10">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute left-1/2 top-[16%] h-80 w-80 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary)_12%,transparent)_0%,transparent_70%)] blur-3xl sm:h-[28rem] sm:w-[28rem]" />
          <div className="absolute inset-x-0 bottom-0 h-48 bg-[linear-gradient(180deg,transparent,color-mix(in_srgb,var(--background)_90%,transparent))]" />
        </div>

        <section className="relative flex w-full max-w-2xl flex-col items-center text-center">
          <div className="mb-7 inline-flex size-14 items-center justify-center rounded-2xl border border-border/50 bg-card/80 shadow-lg shadow-black/5 backdrop-blur-lg">
            <SquarePenIcon className="size-6 text-foreground/80" />
          </div>
          <p className="text-[10px] font-semibold tracking-[0.32em] text-muted-foreground/40 uppercase">
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
              <p className="mt-6 max-w-lg text-sm leading-relaxed text-muted-foreground/60">
                Start from the right project, keep the sidebar in view, and let each new draft
                thread inherit the workspace context you actually want.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button size="lg" onClick={startNewThread}>
                  Start new thread
                  <ArrowRightIcon className="size-4.5" />
                </Button>
                <div className="rounded-full border border-border/50 bg-card/50 px-3.5 py-1.5 text-xs text-muted-foreground/60 shadow-xs/5">
                  {projects.length} {projects.length === 1 ? "project" : "projects"} in sidebar
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="mt-5 max-w-lg text-sm leading-relaxed text-muted-foreground/60">
                Add a project from the sidebar to get started. Once a project is available, new
                threads open with visible project context and a quick switcher.
              </p>
              <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-dashed border-border/50 bg-card/50 px-4 py-2.5 text-sm text-muted-foreground/65">
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
