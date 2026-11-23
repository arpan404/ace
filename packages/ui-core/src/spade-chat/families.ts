import type { SpadeAgent } from "./agents.ts";

type FamilyBot = Pick<SpadeAgent, "id" | "kind" | "parent">;

/** List families stay one level deep, including workers started by other workers. */
export function spadeBotFamilies<T extends FamilyBot>(
  bots: readonly T[],
  keyFor: (bot: T, id: string) => string,
): { root: T; workers: T[] }[] {
  const key = (bot: T) => keyFor(bot, bot.id);
  const byKey = new Map<string, T>();
  for (const bot of bots) if (!byKey.has(key(bot))) byKey.set(key(bot), bot);

  const workersOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const bot of byKey.values()) {
    const maker = bot.kind !== "main" && bot.parent && keyFor(bot, bot.parent.id);
    if (!maker || !byKey.has(maker)) {
      roots.push(bot);
      continue;
    }
    const workers = workersOf.get(maker) ?? [];
    workers.push(bot);
    workersOf.set(maker, workers);
  }

  const reached = new Set<string>();
  const families: { root: T; workers: T[] }[] = [];
  for (const root of [...roots, ...byKey.values()]) {
    if (reached.has(key(root))) continue;
    reached.add(key(root));
    const workers: T[] = [];
    const pending = (workersOf.get(key(root)) ?? []).toReversed();
    while (pending.length) {
      const worker = pending.pop();
      if (!worker || reached.has(key(worker))) continue;
      reached.add(key(worker));
      workers.push(worker);
      const children = workersOf.get(key(worker)) ?? [];
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (child) pending.push(child);
      }
    }
    families.push({ root, workers });
  }
  return families;
}
