import { readJson, writeJson } from "@ace/ui-core";
import { z } from "zod";
import { useLayout } from "@/lib/layout.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";

const key = "ace.forge.project";

/** The project a list reads: the one in the address, else the last chosen if it exists, else the first. */
export function listProject(
  routed: string | undefined,
  remembered: string | undefined,
  projects: readonly string[],
): string | undefined {
  if (routed) return routed;
  if (remembered && projects.includes(remembered)) return remembered;
  return projects[0];
}

/** The project both lists read, and remembering a choice on this device for next time. */
export function useProjectChoice(routed: string | undefined) {
  const { storage } = useLayout();
  const { ids, name, loaded } = useRegisteredProjects();
  const remembered = readJson(storage, key, z.string().min(1).max(512), "") || undefined;
  return {
    project: listProject(routed, remembered, ids),
    projects: ids,
    loaded,
    name,
    remember: (project: string) => writeJson(storage, key, project),
  };
}
