import type { SpadeBubble } from "./bubbles.ts";

/*
 * The chat shows what is said and what needs the person: the person's messages, the bot's
 * replies, cards that wait on the person, and results (files, links). How a reply got there (its
 * steps, the notes it had in mind or saved, where it ran) is work: hidden unless the person
 * shows it, for one turn from that reply's More menu or for every turn with Show work in chat.
 * The whole log stays in the profile's Work tab. Pure, so every client follows the same rule.
 */

/** Which work shows: every turn's (Show work in chat), or the turns the person opened. */
export interface SpadeWorkShown {
  all: boolean;
  turns: ReadonlySet<string>;
}

/** The turn a work line belongs to; undefined for anything that isn't work. */
export function spadeWorkTurn(bubble: SpadeBubble): string | undefined {
  switch (bubble.kind) {
    case "steps":
    case "recalled":
    case "remembered":
      return bubble.turn;
    case "quiet":
      return bubble.quiet.kind === "served" ? bubble.turn : undefined;
    default:
      return undefined;
  }
}

/** The bubbles without the work lines `shown` doesn't show. */
export function spadeWithoutWork<T extends SpadeBubble>(
  bubbles: readonly T[],
  shown: SpadeWorkShown,
): T[] {
  if (shown.all) return [...bubbles];
  return bubbles.filter((bubble) => {
    const turn = spadeWorkTurn(bubble);
    return turn === undefined || shown.turns.has(turn);
  });
}

/** The turns that have work to show, for a reply's Show work. */
export function spadeTurnsWithWork(bubbles: readonly SpadeBubble[]): Set<string> {
  const turns = new Set<string>();
  for (const bubble of bubbles) {
    const turn = spadeWorkTurn(bubble);
    if (turn !== undefined) turns.add(turn);
  }
  return turns;
}
