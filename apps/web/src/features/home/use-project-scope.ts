import { groupProjects, type ProjectGroup } from "@ace/ui-core/project-groups";
import { useMemo } from "react";
import { useOrganizerState } from "@/features/organize/index.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { usePoolProjects } from "@/lib/pool-projects.ts";
import { scopeOf, type ProjectScope } from "./project-scope.ts";

/** Every machine's projects as logical projects, as New thread in… lists them. */
export function useProjectGroups(): readonly ProjectGroup[] {
  const { lists } = usePoolProjects();
  return useMemo(() => groupProjects(lists), [lists]);
}

/** The checkouts the Threads panel's project filter lets through (`scopeOf`). */
export function useProjectScope(): ProjectScope {
  const { project } = useOrganizerState();
  const own = usePrimaryMachine().id;
  const groups = useProjectGroups();
  return useMemo(() => scopeOf(project, groups, own), [project, groups, own]);
}
