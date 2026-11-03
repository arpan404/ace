import { useEffect } from "react";
import { useLayout } from "@/lib/layout.tsx";
import {
  pickedProjects,
  projectsLabel,
  projectsParam,
  readProjects,
  rememberedProjects,
  rememberProjects,
  type ProjectsSearch,
} from "@/lib/forge-projects.ts";
import { useRegisteredProjects } from "@/lib/projects.ts";

/**
 * The projects Code review's lists show (every project unless some are picked), and picking:
 * a pick is remembered on this device and returned as the address's part, so Inbox, Pull
 * requests and Issues all show it, after a reload too. A choice arriving in an address (a link,
 * Back) is remembered as well.
 */
export function useProjectChoice(search: ProjectsSearch) {
  const { storage } = useLayout();
  const { ids, name, loaded } = useRegisteredProjects();
  const remembered = rememberedProjects(storage);
  const picked = loaded ? pickedProjects(search, remembered, ids) : [];
  const routed = search.projects ?? (search.project ? [search.project] : undefined);
  const arrived = loaded && routed !== undefined ? picked.join("\n") : undefined;
  useEffect(() => {
    if (arrived === undefined) return;
    if (rememberedProjects(storage).join("\n") !== arrived)
      rememberProjects(storage, arrived ? arrived.split("\n") : []);
  }, [arrived, storage]);
  const read = readProjects(picked, ids);
  return {
    /** The projects picked; empty is every project. */
    picked,
    /** The projects the list reads. */
    projects: read,
    /** Every project the daemon lists, by name. */
    all: ids,
    /** Exactly one project is shown: rows drop their project tags. */
    one: read.length === 1 ? read[0] : undefined,
    loaded,
    name,
    label: projectsLabel(picked, name),
    /** Remember `next` and return the address's part for it. */
    pick: (next: readonly string[]): { projects: string[] | undefined; project: undefined } => {
      rememberProjects(storage, next);
      return { projects: projectsParam(next), project: undefined };
    },
  };
}

export type ProjectChoice = ReturnType<typeof useProjectChoice>;
