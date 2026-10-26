import { useOpenWork } from "@/features/forge/index.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { loadChoices, pickProject } from "./choices.ts";

/**
 * Loads the open work (pull requests and issues) of the project New thread would open on and
 * keeps it cached. It reads only what New thread itself reads first. Its code (the forge request
 * schemas, the model choices) loads once the app is idle; see `open-work-warmup.tsx`.
 */
export function WarmOpenWork() {
  const { storage } = useLayout();
  const { project: filter } = useOrganizerState();
  const { ids: projects, loaded } = useRegisteredProjects();
  const project = loaded
    ? pickProject(projects, undefined, loadChoices(storage).project, filter)
    : undefined;
  if (!project) return null;
  return <Warm key={project} project={project} />;
}

function Warm(props: { project: string }) {
  useOpenWork(props.project);
  return null;
}
