import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { whenIdle } from "@/lib/idle.ts";
import { keymap } from "@/lib/keymap.ts";
import { useProjectListSync } from "@/lib/project-cache.ts";
import type { ProjectRequest } from "./requests.ts";

// Through a one-line loader, so the dialogs' long list of chunks to preload stays out of the
// first paint's bytes.
const loadDialogs = () => import("./dialogs-loader.ts").then((loader) => loader.load());
const ProjectDialogs = lazy(loadDialogs);

interface ProjectsApi {
  /** Open the Add project dialog on a tab, Rename or Remove, or add a folder by path. */
  open(request: ProjectRequest): void;
  /** Start loading the dialogs (on hover or focus of something that opens them). */
  preload(): void;
}

const ProjectsContext = createContext<ProjectsApi | null>(null);

/** The project dialogs, from anywhere under the app shell. */
export function useProjectDialogs(): ProjectsApi {
  const api = useContext(ProjectsContext);
  if (!api) throw new Error("useProjectDialogs needs <ProjectsHost>");
  return api;
}

/**
 * Projects across the app: the dialogs (loaded on first use, then kept so a clone carries on
 * when its dialog closes), ⇧⌘O, a folder dropped on the window, and the project list kept live
 * from the daemon's pushes.
 */
export function ProjectsHost(props: { children: ReactNode }) {
  const [request, setRequest] = useState<ProjectRequest>();
  const [open, setOpen] = useState(false);
  const show = useCallback((next: ProjectRequest) => {
    setRequest(next);
    setOpen(true);
  }, []);
  const api = useMemo(() => ({ open: show, preload: () => void loadDialogs() }), [show]);
  useProjectListSync();
  useHotkey(keymap.addProject.keys, () => show({ kind: "add", tab: "open" }));
  useFolderDrop(show);
  // Warm the dialogs once the first screen has painted, so they open without a wait.
  useEffect(() => whenIdle(() => void loadDialogs(), 4_000), []);
  return (
    <ProjectsContext.Provider value={api}>
      {props.children}
      {request && (
        <Suspense fallback={null}>
          <ProjectDialogs request={request} open={open} onOpenChange={setOpen} onRequest={show} />
        </Suspense>
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
