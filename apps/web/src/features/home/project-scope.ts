import { defaultCheckout, groupMachines, type ProjectGroup } from "@ace/ui-core/project-groups";
import { inScope, type DeviceScope } from "./device-filter-state.ts";

/*
 * The Threads panel's project filter over logical projects (ADR 0180, ADR 0189): one row per
 * project across the machines in the device filter, as New thread in… groups them. The filter's
 * stored choice stays one checkout: this machine's project id (as before), or `machine/project`
 * for a project with no checkout here. Choosing a row covers every checkout in its group.
 */

/** A checkout's key across machines, as `groupProjects` keys them. */
export const checkoutKey = (machineId: string, workspaceId: string) =>
  `${machineId}/${workspaceId}`;

/** The checkout a stored choice names: a plain id is this machine's. */
const choiceKey = (choice: string, own: string) =>
  choice.includes("/") ? choice : checkoutKey(own, choice);

/** What the filter lets through for `choice`. */
export interface ProjectScope {
  /** Every checkout key the chosen project covers; undefined: every project. */
  checkouts: ReadonlySet<string> | undefined;
  /** This machine's project ids among them. */
  here: readonly string[];
  /** The one project this machine's thread list can be narrowed to, if exactly one. */
  window: string | undefined;
  /** The chosen project's group, when the pool lists it. */
  group: ProjectGroup | undefined;
}

/** The checkouts `choice` covers: its group's, else just the one checkout it names. */
export function scopeOf(
  choice: string | null,
  groups: readonly ProjectGroup[],
  own: string,
): ProjectScope {
  if (choice === null)
    return { checkouts: undefined, here: [], window: undefined, group: undefined };
  const key = choiceKey(choice, own);
  const group = groups.find((each) => each.checkouts.some((checkout) => checkout.key === key));
  const keys = group ? group.checkouts.map((checkout) => checkout.key) : [key];
  const prefix = `${own}/`;
  const here = keys.flatMap((each) => (each.startsWith(prefix) ? [each.slice(prefix.length)] : []));
  return { checkouts: new Set(keys), here, window: here.length === 1 ? here[0] : undefined, group };
}

/** What to store for choosing `group`: this machine's checkout, else its first checkout. */
export function choiceFor(group: ProjectGroup, own: string): string {
  const here =
    defaultCheckout(group, own) ?? group.checkouts.find((each) => each.machineId === own);
  if (here) return here.workspaceId;
  return group.checkouts[0]?.key ?? group.key;
}

/** One row of the filter. */
export interface FilterRow {
  /** The stored choice it sets. */
  value: string;
  /** Its name; one with no checkout here also names the machines it is on. */
  label: string;
  /** Threads in it across the machines the device filter lets through. */
  threads: number;
  /** This machine's checkout the row's actions act on; none when it has no checkout here. */
  actsOn: string | undefined;
}

/**
 * The filter's rows, by label: each logical project with a checkout on a machine in `device`,
 * its count summed over those machines' checkouts, then this machine's projects only threads
 * still mention. `counts` is threads per checkout key. `chosen` keeps its own value on the row
 * it belongs to, so the row reads as selected whichever of its checkouts was stored.
 */
export function filterRows(input: {
  groups: readonly ProjectGroup[];
  device: DeviceScope;
  own: string;
  counts: ReadonlyMap<string, number>;
  chosen: string | null;
  /** A name for a project only threads mention here. */
  name(id: string): string;
  isChat(id: string): boolean;
}): FilterRow[] {
  const { groups, device, own, counts, chosen } = input;
  const chosenKey = chosen === null ? undefined : choiceKey(chosen, own);
  const grouped = new Set<string>();
  const rows: FilterRow[] = [];
  for (const group of groups) {
    for (const checkout of group.checkouts) grouped.add(checkout.key);
    const shown = group.checkouts.filter((each) => inScope(device, each.machineId));
    if (!shown.length) continue;
    const isChosen = group.checkouts.some((each) => each.key === chosenKey);
    const here =
      defaultCheckout(group, own) ?? group.checkouts.find((each) => each.machineId === own);
    rows.push({
      value: isChosen && chosen !== null ? chosen : choiceFor(group, own),
      label: here ? group.label : `${group.label} · ${groupMachines(group).join(", ")}`,
      threads: shown.reduce((sum, each) => sum + (counts.get(each.key) ?? 0), 0),
      actsOn: here?.workspaceId,
    });
  }
  if (inScope(device, own)) {
    const prefix = `${own}/`;
    for (const [key, threads] of counts) {
      if (!key.startsWith(prefix) || grouped.has(key)) continue;
      const id = key.slice(prefix.length);
      if (input.isChat(id)) continue;
      rows.push({ value: id, label: input.name(id), threads, actsOn: undefined });
    }
  }
  return rows.toSorted((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}
