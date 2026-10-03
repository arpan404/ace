import type { PaletteCommand } from "@ace/protocol";
export interface Usage {
  count: number;
  last: number;
}
export function fuzzyScore(query: string, name: string): number | undefined {
  if (!query) return 0;
  let at = 0,
    score = 0,
    previous = -2;
  for (const char of query) {
    const found = name.indexOf(char, at);
    if (found < 0) return undefined;
    score +=
      10 +
      (found === previous + 1 ? 8 : 0) +
      (found === 0 || /[.:_-]/.test(name[found - 1] ?? "") ? 12 : 0) -
      Math.min(found - at, 10);
    previous = found;
    at = found + 1;
  }
  return score + (name === query ? 100 : name.startsWith(query) ? 30 : 0);
}
interface Ranked<T> {
  command: T;
  score: number;
}
const compare = <T extends PaletteCommand>(a: Ranked<T>, b: Ranked<T>) =>
  a.score - b.score || b.command.id.localeCompare(a.command.id);
/** A min heap keeps only the best k entries, O(n log k) time and O(k) ranking memory. */
export function searchCommands<T extends PaletteCommand>(
  commands: Iterable<T>,
  query: string,
  limit: number,
  usage: ReadonlyMap<string, Usage>,
  now: number,
): T[] {
  const q = query.replace(/^\//, "").toLowerCase(),
    top: Ranked<T>[] = [];
  const bound = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  for (const command of commands) {
    const lexical =
      fuzzyScore(q, command.name.toLowerCase()) ?? fuzzyScore(q, command.description.toLowerCase());
    if (lexical === undefined) continue;
    const used = usage.get(command.id);
    const score =
      lexical +
      (used
        ? Math.min(20, Math.log2(used.count + 1) * 4) +
          12 / (1 + Math.max(0, now - used.last) / 86400000)
        : 0);
    const candidate = { command, score };
    if (top.length < bound) {
      top.push(candidate);
      let at = top.length - 1;
      while (at > 0) {
        const parentIndex = Math.floor((at - 1) / 2),
          parent = top[parentIndex];
        if (!parent || compare(candidate, parent) >= 0) break;
        top[at] = parent;
        at = parentIndex;
      }
      top[at] = candidate;
    } else {
      const root = top[0];
      if (!root || compare(candidate, root) <= 0) continue;
      let at = 0;
      while (true) {
        const leftIndex = at * 2 + 1,
          rightIndex = leftIndex + 1,
          left = top[leftIndex],
          right = top[rightIndex];
        if (!left) break;
        const childIndex = right && compare(right, left) < 0 ? rightIndex : leftIndex,
          child = top[childIndex];
        if (!child || compare(candidate, child) <= 0) break;
        top[at] = child;
        at = childIndex;
      }
      top[at] = candidate;
    }
  }
  return top.toSorted((a, b) => compare(b, a)).map((v) => v.command);
}
