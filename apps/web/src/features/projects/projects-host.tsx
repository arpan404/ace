import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { whenIdle } from "@/lib/idle.ts";
import { keymap } from "@/lib/keymap.ts";
import { useProjectListSync } from "@/lib/project-cache.ts";
import { useLayout, type PalettePage } from "@/lib/layout.tsx";
import { useMachines } from "@/lib/machines.ts";
import { useLandInProject } from "./land.ts";
import type { AddTab, ProjectRequest } from "./requests.ts";
import { ProjectsContext } from "./projects-context.ts";
import { useCloneRun } from "./use-clone-run.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";

// Through a one-line loader, so the dialogs' long list of chunks to preload stays out of the
// first paint's bytes.
const loadDialogs = () => import("./dialogs-loader.ts").then((loader) => loader.load());
/** Load the dialogs now, as the shell does once idle (tests start with them warm). */
const ProjectDialogs = deferredComponent(() => loadDialogs().then((module) => module.default));
export const preloadProjectDialogs = (): Promise<unknown> => ProjectDialogs.preload();
const warmDialogs = () => {
  void preloadProjectDialogs().catch(() => {});
  // Add project's palette steps, too.
  void import("./add-project-flow.tsx").catch(() => {});
};

/** The palette step each Add project source opens on. */
const addPages: Record<AddTab, PalettePage> = {
  sources: "add-project",
  open: "add-local",
  create: "add-create",
  clone: "add-clone",
  github: "add-github",
};

export { useProjectDialogs, useProjectDialogsIfHosted } from "./projects-context.ts";

/**
 * Projects across the app: Add project opens in the palette; the other dialogs load on first
 * use. Also ⇧⌘O, a folder dropped on the window, the clone in progress (it carries on when the
 * palette closes) and the project list kept live from the daemon's pushes.
 */
export function ProjectsHost(props: { children: ReactNode }) {
  const [request, setRequest] = useState<ProjectRequest>();
  const [open, setOpen] = useState(false);
  const { openPalette, setPaletteOpen } = useLayout();
  const show = useCallback(
    (next: ProjectRequest) => {
      if (next.kind === "add") {
        openPalette({ page: addPages[next.tab], attempt: next.attempt, clone: next.clone });
        return;
      }
      setRequest(next);
      setOpen(true);
    },
    [openPalette],
  );
  const land = useLandInProject();
  const machines = useMachines();
  const clone = useCloneRun({
    machines,
    onCloned: (result, machine) => {
      setPaletteOpen(false);
      land(result, "Cloned", { machine });
    },
  });
  const api = useMemo(() => ({ open: show, preload: warmDialogs, clone }), [show, clone]);
  useProjectListSync();
  useHotkey(keymap.addProject.keys, () => show({ kind: "add", tab: "sources" }));
  useFolderDrop(show);
  // Warm the dialogs once the first screen has painted, so they open without a wait.
  useEffect(() => whenIdle(warmDialogs, 4_000), []);
  return (
    <ProjectsContext.Provider value={api}>
      {props.children}
      {request && (
        <LocalBoundary label="project dialogs" fallback={null}>
          <Suspense fallback={null}>
            <ProjectDialogs.Component
              request={request}
              open={open}
              onOpenChange={setOpen}
              onRequest={show}
            />
          </Suspense>
        </LocalBoundary>
      )}
    </ProjectsContext.Provider>
  );
}

/**
 * A folder dropped anywhere that doesn't take files itself (the composer does) becomes a
 * project. The desktop app knows the folder's path; a browser doesn't share it, so there the
 * drop opens Add project to pick the folder from the daemon's side (`project-dialogs.tsx`).
 */
function useFolderDrop(show: (request: ProjectRequest) => void) {
  useEffect(() => {
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const over = (event: DragEvent) => {
      if (event.defaultPrevented || !carriesFiles(event)) return;
      // Accept the drop here, so the page never navigates to a dropped file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (event.defaultPrevented || !carriesFiles(event)) return;
      event.preventDefault();
      const folder = [...(event.dataTransfer?.items ?? [])].find(
        (item) => item.kind === "file" && item.webkitGetAsEntry()?.isDirectory,
      );
      const file = folder?.getAsFile();
      if (!file) return;
      show({ kind: "dropped", file });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [show]);
}
