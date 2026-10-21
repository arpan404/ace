import type { Item } from "@ace/protocol";
import { groupSteps, stepFact, type StepFact } from "@ace/ui-core";

// Grouping uses the browser's facts. Text stays on separately observed native item rows.
const facts = new WeakMap<Item, StepFact | null>();

type Group = {
  id: string;
  items: string[];
  single: boolean;
  label: string;
  icon: string;
  running: boolean;
  active: string;
};

function grouped(steps: StepFact[]): Group[] {
  return groupSteps(steps).groups.map((group) => ({
    id: group.key,
    items: [...group.ids],
    single: group.single,
    label: group.summary,
    icon: group.icon,
    running: group.running,
    active: group.active ?? group.newest,
  }));
}

/**
 * A work log's steps in groups, as the web's work log groups them. A call in `apart` (one that
 * left a command running in the background) stands as its own line where it started, never
 * folded into a group.
 */
export function workGroups(
  ids: readonly string[],
  read: (id: string) => Item | undefined,
  ended: (item: Item) => boolean = () => false,
  apart: ReadonlySet<string> = new Set(),
): Group[] {
  const groups: Group[] = [];
  let steps: StepFact[] = [];
  for (const id of ids) {
    const item = read(id);
    if (!item) continue;
    let fact = facts.get(item);
    if (fact === undefined) {
      fact = stepFact(item) ?? null;
      facts.set(item, fact);
    }
    if (!fact) continue;
    const step = fact.running && ended(item) ? { ...fact, running: false } : fact;
    if (!apart.has(id)) {
      steps.push(step);
      continue;
    }
    groups.push(...grouped(steps));
    steps = [];
    groups.push({
      id,
      items: [id],
      single: true,
      label: "",
      icon: "shell",
      running: false,
      active: id,
    });
  }
  groups.push(...grouped(steps));
  return groups;
}
