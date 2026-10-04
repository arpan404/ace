import type { Fact } from "@ace/core";

/** Only adjacent appends merge. Bound the accumulator and preserve every non-delta boundary. */
export function coalesceFacts(facts: readonly Fact[]): Fact[] {
  const result: Fact[] = [];
  for (let index = 0; index < facts.length; index++) {
    const fact = facts[index];
    if (!fact) continue;
    const previous = result.at(-1);
    const next = facts[index + 1];
    // Codex/Claude put a transport signal before each delta. The first signal
    // already covers this same-clock run of appends; retain it and all boundaries.
    if (
      fact.type === "signal" &&
      previous?.type === "item.delta" &&
      next?.type === "item.delta" &&
      fact.agent === previous.agent &&
      next.agent === previous.agent &&
      next.item === previous.item &&
      next.field === previous.field &&
      Buffer.byteLength(previous.append) + Buffer.byteLength(next.append) <= 4096
    )
      continue;
    if (
      fact.type === "item.delta" &&
      previous?.type === "item.delta" &&
      fact.agent === previous.agent &&
      fact.item === previous.item &&
      fact.field === previous.field &&
      Buffer.byteLength(previous.append) + Buffer.byteLength(fact.append) <= 4096
    ) {
      result[result.length - 1] = { ...previous, append: previous.append + fact.append };
    } else result.push(fact);
  }
  return result;
}
