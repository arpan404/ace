import { createContext, useContext } from "react";
import type { ProjectRequest } from "./requests.ts";
import type { CloneControl } from "./use-clone-run.ts";

export interface ProjectsApi {
  /** Open Add project (in the palette) on a source, Edit or Remove, or add a folder by path. */
  open(request: ProjectRequest): void;
  /** Start loading the dialogs (on hover or focus of something that opens them). */
  preload(): void;
  /** The one clone in progress, kept here so it carries on when the palette closes. */
  clone: CloneControl;
}

export const ProjectsContext = createContext<ProjectsApi | null>(null);

/** The project dialogs, from anywhere under the app shell (`ProjectsHost`). */
export function useProjectDialogs(): ProjectsApi {
  const api = useContext(ProjectsContext);
  if (!api) throw new Error("useProjectDialogs needs <ProjectsHost>");
  return api;
}
