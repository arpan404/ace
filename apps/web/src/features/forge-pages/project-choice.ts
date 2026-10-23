import { readJson, writeJson } from "@ace/ui-core";
import { z } from "zod";
import { useLayout } from "@/lib/layout.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";
import type { FilterSection } from "./filters-menu.tsx";

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

export type ProjectChoice = ReturnType<typeof useProjectChoice>;

/**
 * The Filters menu's Project part, a view setting, when there is more than one project to pick:
 * picking one remembers it and hands it to `onPick`.
 */
export function projectSection(
  choice: ProjectChoice,
  onPick: (project: string) => void,
): FilterSection[] {
  const current = choice.project;
  if (!current || choice.projects.length < 2) return [];
  return [
    {
      kind: "one",
      id: "project",
      label: "Project",
      setting: true,
      value: current,
      choices: choice.projects.map((id) => ({ value: id, label: choice.name(id) })),
      onChange: (next) => {
        choice.remember(next);
        onPick(next);
      },
    },
  ];
}
