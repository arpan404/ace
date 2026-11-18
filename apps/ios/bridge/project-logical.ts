import type { Project } from "@ace/protocol";
import { groupProjects } from "@ace/ui-core/project-groups";

/**
 * Each of one machine's projects' logical project ids (ADR 0180), as `groupProjects` groups
 * the list: its identity and every alias joined to it there. A project of its own has none.
 * Each machine has its own runtime, so the app matches a project across machines by these.
 */
export function logicalIds(projects: readonly Project[]): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  for (const group of groupProjects([
    { machineId: "here", machineName: "", online: true, here: true, projects },
  ]))
    for (const checkout of group.checkouts) ids.set(checkout.workspaceId, group.identityIds);
  return ids;
}
