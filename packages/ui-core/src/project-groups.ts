/*
 * Logical projects across the person's machines (ADR 0180): one group per project, holding each
 * machine's checkouts (registrations) of it. Registrations group as connected components of the
 * identity ids and alias edges every machine reports, so a machine that was offline during a
 * merge, still reporting the old id, joins through an alias another machine keeps. Chains
 * across machines (A: Q→P, B: P→R) join the same way; nothing is flattened. A registration
 * without an identity, or on an older daemon, is a group of its own.
 *
 * The one grouping web and iOS use. Pure: the caller passes every machine's last list.
 */

/** What grouping reads of a registration (`Project` on the wire). */
export interface GroupableProject {
  id: string;
  name: string;
  path: string;
  kind?: string | undefined;
  identity?: { id: string; aliases: readonly string[] } | undefined;
  openedAt?: number | undefined;
}

/** One machine's last project list. Offline: the list kept from when it was last reached. */
export interface MachineProjectList {
  machineId: string;
  machineName: string;
  online: boolean;
  /** This window's own machine: its name labels a group first. */
  here?: boolean | undefined;
  projects: readonly GroupableProject[];
}

export interface ProjectCheckout {
  /** `machineId/workspaceId`, unique across machines. */
  key: string;
  machineId: string;
  machineName: string;
  workspaceId: string;
  name: string;
  path: string;
  online: boolean;
  here: boolean;
  openedAt?: number | undefined;
  identityId?: string | undefined;
}

/** The machines a group's checkouts are on, this one first, then by name. */
export function groupMachines(group: ProjectGroup): string[] {
  const here = group.checkouts.filter((each) => each.here).map((each) => each.machineName);
  const others = group.checkouts
    .filter((each) => !each.here)
    .map((each) => each.machineName)
    .toSorted((a, b) => a.localeCompare(b));
  return [...new Set([...here, ...others])];
}

export interface ProjectGroup {
  /** Stable while the group's membership is: its smallest identity id, else its checkout. */
  key: string;
  label: string;
  /** The names its checkouts go by, when they differ: shown on a second line. */
  otherNames: string[];
  /** Selectable first, then most recently used. */
  checkouts: ProjectCheckout[];
  /** Every identity id the group reports, for merges. */
  identityIds: string[];
  /** No checkout can be picked: every machine that has it is offline. */
  offline: boolean;
}

class Components {
  private parent = new Map<string, string>();
  find(node: string): string {
    let root = node;
    for (
      let up = this.parent.get(root);
      up !== undefined && up !== root;
      up = this.parent.get(root)
    )
      root = up;
    // Path compression keeps later finds short.
    for (let at = node; at !== root;) {
      const next = this.parent.get(at) ?? root;
      this.parent.set(at, root);
      at = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }
  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

const recency = (a: ProjectCheckout, b: ProjectCheckout) =>
  (b.openedAt ?? -1) - (a.openedAt ?? -1) || a.key.localeCompare(b.key);

/** Selectable before offline, then most recently used, then by key. */
export const checkoutOrder = (a: ProjectCheckout, b: ProjectCheckout) =>
  Number(b.online) - Number(a.online) || recency(a, b);

/** Every machine's registrations as logical projects, by label. Chats are never projects. */
export function groupProjects(lists: readonly MachineProjectList[]): ProjectGroup[] {
  const components = new Components();
  const checkouts: ProjectCheckout[] = [];
  for (const list of lists)
    for (const project of list.projects) {
      if (project.kind !== undefined) continue;
      const identity = project.identity;
      if (identity) for (const alias of identity.aliases) components.join(identity.id, alias);
      checkouts.push({
        key: `${list.machineId}/${project.id}`,
        machineId: list.machineId,
        machineName: list.machineName,
        workspaceId: project.id,
        name: project.name,
        path: project.path,
        online: list.online,
        here: list.here === true,
        ...(project.openedAt === undefined ? {} : { openedAt: project.openedAt }),
        ...(identity ? { identityId: identity.id } : {}),
      });
    }
  const groups = new Map<string, { checkouts: ProjectCheckout[]; ids: Set<string> }>();
  const ids = new Map<string, Set<string>>();
  for (const list of lists)
    for (const project of list.projects) {
      if (project.kind !== undefined || !project.identity) continue;
      for (const id of [project.identity.id, ...project.identity.aliases]) {
        const root = components.find(id);
        const known = ids.get(root) ?? new Set<string>();
        known.add(id);
        ids.set(root, known);
      }
    }
  for (const checkout of checkouts) {
    const root = checkout.identityId ? components.find(checkout.identityId) : `@${checkout.key}`;
    const group = groups.get(root) ?? { checkouts: [], ids: ids.get(root) ?? new Set() };
    group.checkouts.push(checkout);
    groups.set(root, group);
  }
  return [...groups]
    .map(([root, group]) => describe(root, group.checkouts, [...group.ids].toSorted()))
    .toSorted(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        Number(b.checkouts.some((each) => each.here)) -
          Number(a.checkouts.some((each) => each.here)) ||
        a.key.localeCompare(b.key),
    );
}

function describe(root: string, members: ProjectCheckout[], identityIds: string[]): ProjectGroup {
  const checkouts = members.toSorted(checkoutOrder);
  // This machine's own name for it first, else the most recently used checkout's.
  const named = checkouts.filter((each) => each.here).toSorted(recency)[0] ??
    members.toSorted(recency)[0] ?? { name: "Project" };
  const otherNames = [...new Set(checkouts.map((each) => each.name))].filter(
    (name) => name !== named.name,
  );
  return {
    key: root.startsWith("@") ? root.slice(1) : root,
    label: named.name,
    otherNames,
    checkouts,
    identityIds,
    offline: !checkouts.some((each) => each.online),
  };
}

/**
 * Where work in `group` starts by default: on `machineId` its most recently used checkout there,
 * without a machine this machine's, else the most recently used anywhere. Offline checkouts are
 * never the default.
 */
export function defaultCheckout(
  group: ProjectGroup,
  machineId?: string,
): ProjectCheckout | undefined {
  const selectable = group.checkouts.filter((each) => each.online).toSorted(recency);
  if (machineId !== undefined) return selectable.find((each) => each.machineId === machineId);
  return selectable.find((each) => each.here) ?? selectable[0];
}

/** The group a registration belongs to, by machine and workspace id. */
export function groupOf(
  groups: readonly ProjectGroup[],
  machineId: string,
  workspaceId: string,
): ProjectGroup | undefined {
  const key = `${machineId}/${workspaceId}`;
  return groups.find((group) => group.checkouts.some((each) => each.key === key));
}
