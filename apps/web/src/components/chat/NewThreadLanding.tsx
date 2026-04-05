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
        <header className="border-b border-border px-3 py-2 sm:px-5">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-sm font-medium text-foreground">New thread</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center justify-between border-b border-border px-5">
          <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
            New thread
          </span>
          {activeProject ? (
            <span className="max-w-52 truncate text-[11px] text-muted-foreground/48">
              {activeProject.name}
            </span>
          ) : null}
        </div>
      )}

      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-6 py-10 sm:px-10">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute left-1/2 top-[18%] h-72 w-72 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary)_18%,transparent)_0%,transparent_68%)] blur-3xl sm:h-96 sm:w-96" />
          <div className="absolute inset-x-0 bottom-0 h-40 bg-[linear-gradient(180deg,transparent,color-mix(in_srgb,var(--background)_85%,transparent))]" />
        </div>

        <section className="relative flex w-full max-w-3xl flex-col items-center text-center">
          <div className="mb-6 inline-flex size-16 items-center justify-center rounded-[1.35rem] border border-border/70 bg-card/72 shadow-2xl shadow-black/10 backdrop-blur-md">
            <SquarePenIcon className="size-7 text-foreground/88" />
          </div>
          <p className="text-[11px] font-semibold tracking-[0.28em] text-muted-foreground/45 uppercase">
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
              <p className="mt-6 max-w-xl text-sm leading-relaxed text-muted-foreground/68">
                Start from the right project, keep the sidebar in view, and let each new draft
                thread inherit the workspace context you actually want.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button size="lg" onClick={startNewThread}>
                  Start new thread
                  <ArrowRightIcon className="size-4.5" />
                </Button>
                <div className="rounded-full border border-border/70 bg-card/55 px-3 py-1.5 text-xs text-muted-foreground/70 shadow-xs/5">
                  {projects.length} {projects.length === 1 ? "project" : "projects"} in sidebar
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground/68">
                Add a project from the sidebar to get started. Once a project is available, new
                threads open with visible project context and a quick switcher.
              </p>
              <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-dashed border-border/70 bg-card/55 px-4 py-2 text-sm text-muted-foreground/72">
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
