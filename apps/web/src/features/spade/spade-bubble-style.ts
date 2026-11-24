/*
 * A Spade conversation's bubbles (docs/design/spade.md §3), from the chat tokens: the bot's
 * filled on `--chat-bubble` at most 64ch, the person's in the accent at most 56ch, both at the
 * 18 corner with 18px sides and 10px ends, prose 15/24.
 */

const shape =
  "min-w-0 rounded-[22px] px-(--chat-bubble-x) font-prose text-prose leading-6 wrap-anywhere";

/** How wide each side's bubble may grow, against the conversation's column. */
export const bubbleWidth = {
  bot: "max-w-[min(100%,64ch)]",
  mine: "max-w-[min(85%,56ch)]",
} as const;

/** The bot's words: a soft block, no border, 22 corner, 16 by 18 padding. */
export const chatBubble = `${shape} ${bubbleWidth.bot} bg-chat-bubble py-4 text-foreground`;

/**
 * Another bot's message to this one: input, so on the person's side at their width, but drawn
 * in outline on the page rather than filled in the accent, so it is never taken for theirs.
 */
export const inputBubble = `${shape} ${bubbleWidth.mine} border border-border bg-transparent py-2.5 text-foreground dark:border-border-strong`;

/** The person's words: a pill in the bot's colour (`--chat-mine`, set per conversation by SpadeChat). */
export const mineBubble = `${shape} ${bubbleWidth.mine} bg-chat-mine py-2.5 text-chat-mine-foreground`;

/** A bubble inside `BubbleFrame`, which holds its width limit: it may fill the frame. */
export const framed = "max-w-full";
