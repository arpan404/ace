import { spadeChatReactions } from "@ace/ui-core/spade-chat";

type Json = Record<string, unknown>;
type Stored = { seq: number; event: Json };

/*
 * Reactions as Spade serves them (spade/docs/chat-core.md): the person's through
 * `POST|DELETE …/messages/{id}/reactions`, the bot's from `<react to="m12">👍</react>` in its
 * words. Both are stored `reaction` events; neither starts a turn.
 */

/** Whether `message` (`m<seq>` or `m<seq>.<n>`) names an event of the conversation. */
export function fakeReactionTarget(events: readonly Stored[], message: string): boolean {
  const match = /^m(\d+)(?:\.\d+)?$/.exec(message);
  return match !== null && events.some((stored) => stored.seq === Number(match[1]));
}

/** The emoji a request carries, or undefined when it isn't one Spade would take. */
export function fakeReactionEmoji(body: Json): string | undefined {
  const emoji = body.emoji;
  if (typeof emoji !== "string" || emoji === "" || new TextEncoder().encode(emoji).length > 16)
    return undefined;
  return /[\s\p{Cc}]/u.test(emoji) ? undefined : emoji;
}

/** The person's reaction (or taking it back) as the event Spade stores. */
export const fakePersonReaction = (message: string, emoji: string, removed = false): Json => ({
  type: "reaction",
  message,
  emoji,
  by: "person",
  ...(removed ? { removed: true } : {}),
});

/** The bot's reactions its finished words make, as stored events. */
export function fakeBotReactions(text: string, events: readonly Stored[]): Json[] {
  return spadeChatReactions(text)
    .filter((each) => fakeReactionTarget(events, each.to))
    .map((each) => ({ type: "reaction", message: each.to, emoji: each.emoji, by: "bot" }));
}
