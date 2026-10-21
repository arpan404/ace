import type { Item } from "@ace/protocol";
import { groupSteps, stepFact, type StepFact } from "@ace/ui-core";

// Grouping uses the browser's facts. Text stays on separately observed native item rows.
const facts = new WeakMap<Item, StepFact | null>();
export function workGroups(
  ids: readonly string[],
  read: (id: string) => Item | undefined,
  ended: (item: Item) => boolean = () => false,
) {
  const steps: StepFact[] = [];
  for (const id of ids) {
    const item = read(id);
    if (!item) continue;
    let fact = facts.get(item);
    if (fact === undefined) {
      fact = stepFact(item) ?? null;
      facts.set(item, fact);
    }
    if (fact) steps.push(fact.running && ended(item) ? { ...fact, running: false } : fact);
  }
  return groupSteps(steps).groups.map((group) => ({
    id: group.key,
    items: group.ids,
    single: group.single,
    label: group.summary,
    icon: group.icon,
    running: group.running,
    active: group.active ?? group.newest,
  }));
}
