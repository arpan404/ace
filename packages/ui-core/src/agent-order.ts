/*
 * The order a phone lists sibling agents in, on the Agents page and in the Summary alike: who
 * waits on the person, then what still works, then the rest, newest first. Pure.
 */

/** What an agent's place in the list is read from: its whole branch, not only itself. */
export interface AttentionFacts {
  /** It, or anything under it, waits on the person. */
  needsYou: boolean;
  /** It, or anything under it, still works or waits. */
  live: boolean;
}

const tier = (facts: AttentionFacts) => (facts.needsYou ? 0 : facts.live ? 1 : 2);

/**
 * A comparator for `toSorted`: needs you, then working, then everything else, each tier newest
 * first by `started`.
 */
export function attentionOrder<T>(
  facts: (entry: T) => AttentionFacts,
  started: (entry: T) => number,
): (left: T, right: T) => number {
  return (left, right) => tier(facts(left)) - tier(facts(right)) || started(right) - started(left);
}
