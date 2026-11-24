import { z } from "zod";

/*
 * Reactions (spade/docs/chat-core.md, "Messages, ids and replies"): one emoji from each side on a
 * message, stored as `reaction` events and folded to the latest per side. The person's goes in
 * through the reactions API; the bot's comes from `<react to="m12">👍</react>` in its words.
 */

/** The six the picker offers first. */
export const spadeQuickReactions = ["👍", "❤️", "😂", "😮", "🙏", "👎"] as const;

/** What each side has put on one message. */
export interface SpadeMessageReactions {
  person?: string;
  bot?: string;
}

export const spadeReactionEvents = [
  z.object({
    type: z.literal("reaction"),
    /** The message's id (`m12`, `m12.3`). */
    message: z.string().min(1).max(40),
    /** Empty on a take-back of a reaction Spade had no record of. */
    emoji: z.string().max(32).catch(""),
    by: z.enum(["person", "bot"]).catch("bot"),
    removed: z.boolean().catch(false).optional(),
  }),
] as const;

/** Fold one reaction event into the map, in place: the latest per side, removed clears it. */
export function spadeFoldReaction(
  into: Map<string, SpadeMessageReactions>,
  event: { message: string; emoji: string; by: "person" | "bot"; removed?: boolean | undefined },
): void {
  const now = { ...into.get(event.message) };
  if (event.removed) delete now[event.by];
  else now[event.by] = event.emoji;
  if (now.person === undefined && now.bot === undefined) into.delete(event.message);
  else into.set(event.message, now);
}
