/*
 * A Spade conversation's bubbles (docs/design/spade.md §3), from the chat tokens: the bot's
 * filled on `--chat-bubble` at most 64ch, the person's in the accent at most 56ch, both at the
 * 18 corner with 18px sides and 10px ends, prose 15/24.
 */

const shape =
  "min-w-0 rounded-(--chat-bubble-radius) px-(--chat-bubble-x) py-(--chat-bubble-y) font-prose text-prose leading-6 wrap-anywhere";

/** How wide each side's bubble may grow, against the conversation's column. */
export const bubbleWidth = {
  bot: "max-w-[min(100%,64ch)]",
  mine: "max-w-[min(85%,56ch)]",
} as const;

/** The bot's words. */
export const chatBubble = `${shape} ${bubbleWidth.bot} bg-chat-bubble text-foreground`;

/** The person's words, in the accent. */
export const mineBubble = `${shape} ${bubbleWidth.mine} bg-chat-mine text-chat-mine-foreground`;

/** A bubble inside `BubbleFrame`, which holds its width limit: it may fill the frame. */
export const framed = "max-w-full";
