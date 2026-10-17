/** Projects: add (open, create, clone), rename and remove, and the first-run empty state. */
import { deferredComponent } from "@/lib/deferred-component.tsx";

export { ProjectsHost, preloadProjectDialogs, useProjectDialogs } from "./projects-host.tsx";
export { ProjectsEmptyState } from "./projects-empty.tsx";
export { AddProjectItem, ManageProjectItems } from "./project-menu-items.tsx";
export { OpenFolderScreen } from "./open-folder-screen.tsx";
export { useNewProjectFolder } from "./new-project-folder.ts";
export { projectFailure } from "./project-commands.ts";
export { useOpenProject } from "./open-project.ts";
export { useNewThreadEntry } from "./new-thread-entry.ts";
export { isAddPage, projectSources, type AddPage } from "./project-sources.ts";
export type { AddTab, ProjectRequest } from "./requests.ts";

/** Add project's steps inside the palette, loaded with their first use (`add-project-flow`). */
export const AddProjectSteps = deferredComponent(() =>
  import("./add-project-flow.tsx").then((module) => module.AddProjectFlow),
);
