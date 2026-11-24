import {
  spadeAggregateReactions,
  spadeChatReactions,
  spadeFoldReaction,
  type SpadeMessageReactions,
  type SpadeReactionGroup,
} from "@ace/ui-core/spade-chat";

type Json = Record<string, unknown>;
type Stored = { seq: number; event: Json };

/*
 * Reactions as Spade serves them (spade/docs/chat-core.md): the person's through
 * `POST|DELETE …/messages/{id}/reactions`, the bot's from `<react to="m12">👍</react>` in its
 * words (with `agent` in a club). Both are stored `reaction` events; neither starts a turn.
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

/** A club member bot's reaction as the event Spade stores. */
export const fakeMemberReaction = (
  message: string,
  emoji: string,
  agent: string,
  removed = false,
): Json => ({
  type: "reaction",
  message,
  emoji,
  by: "bot",
  agent,
  ...(removed ? { removed: true } : {}),
});

/** The bot's reactions its finished words make, as stored events. */
export function fakeBotReactions(text: string, events: readonly Stored[], agent?: string): Json[] {
  return spadeChatReactions(text)
    .filter((each) => fakeReactionTarget(events, each.to))
    .map((each) => ({
      type: "reaction",
      message: each.to,
      emoji: each.emoji,
      by: "bot",
      ...(agent ? { agent } : {}),
    }));
}

/** Standing reactions per message in `events`, grouped as `{ emoji, by[] }`. */
export function fakeReactionsSummary(
  events: readonly Stored[],
): Record<string, SpadeReactionGroup[]> {
  const folded = new Map<string, SpadeMessageReactions>();
  for (const stored of events) {
    const event = stored.event;
    if (event.type !== "reaction" || typeof event.message !== "string") continue;
    spadeFoldReaction(folded, {
      message: event.message,
      emoji: typeof event.emoji === "string" ? event.emoji : "",
      by: event.by === "person" ? "person" : "bot",
      agent: typeof event.agent === "string" ? event.agent : undefined,
      removed: event.removed === true,
    });
  }
  const out: Record<string, SpadeReactionGroup[]> = {};
  for (const [message, entry] of folded) {
    const groups = spadeAggregateReactions([entry]);
    if (groups.length > 0) out[message] = groups;
  }
  return out;
}
