import type { Project } from "@ace/protocol";
import { groupProjects, remoteNode } from "@ace/ui-core/project-groups";

/**
 * Each of one machine's projects' logical project ids (ADR 0180, ADR 0189), as `groupProjects`
 * groups the list: its group's identity ids and every alias joined to them there, and the
 * remote node (`remoteNode`) of each checkout in the group. A project of its own has none.
 *
 * Each machine has its own runtime, so the app matches a project across machines by these: a
 * checkout there whose ids meet these is in the same group `groupProjects` would make of the
 * two machines' lists. Every edge between the two lists runs through a node one of these
 * names, so if the group has any checkout there, one of them meets these.
 */
export function logicalIds(projects: readonly Project[]): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  const remotes = new Map<string, string>();
  for (const project of projects) {
    const node = remoteNode(project.remoteKey);
    if (node && project.kind === undefined) remotes.set(project.id, node);
  }
  for (const group of groupProjects([
    { machineId: "here", machineName: "", online: true, here: true, projects },
  ])) {
    const nodes = new Set(group.checkouts.flatMap((each) => remotes.get(each.workspaceId) ?? []));
    const logical = [...group.identityIds, ...[...nodes].toSorted()];
    for (const checkout of group.checkouts) ids.set(checkout.workspaceId, logical);
  }
  return ids;
}
