import type { BubbleStackPosition } from "./spade-chat-coalesce.ts";

/*
 * A Spade conversation's bubbles: 15px prose at 1.5 line height, 18px radius, max width ~70% of
 * the column on desktop, 10px 14px padding for short one-liners and 14px 16px for longer or
 * quoted blocks. Stacked bubbles tighten joined corners to 6px on the aligned side.
 */

const baseShape =
  "min-w-0 rounded-(--chat-bubble-radius) font-prose text-prose leading-[1.5] wrap-anywhere";

/** Padding by message length: compact for short messages, roomier for multi-line/quoted blocks. */
export const bubblePadding = (long: boolean) => (long ? "px-4 py-3.5" : "px-3.5 py-2.5");

/** Messenger-style joined corners on the aligned edge of stacked bubbles. */
export function stackCorners(side: "bot" | "mine", stack: BubbleStackPosition): string {
  if (stack === "single") return "";
  if (side === "bot") {
    if (stack === "first") return "rounded-bl-[6px]";
    if (stack === "middle") return "rounded-tl-[6px] rounded-bl-[6px]";
    return "rounded-tl-[6px]";
  }
  if (stack === "first") return "rounded-br-[6px]";
  if (stack === "middle") return "rounded-tr-[6px] rounded-br-[6px]";
  return "rounded-tr-[6px]";
}

/** How wide each side's bubble may grow, against the conversation's column (~70% on desktop). */
export const bubbleWidth = {
  bot: "max-w-[85%] sm:max-w-[70%]",
  mine: "max-w-[85%] sm:max-w-[70%]",
} as const;

/** The bot's words: a soft block, no border, 18px radius, roomier padding by default. */
export const chatBubble = `${baseShape} ${bubbleWidth.bot} bg-chat-bubble px-4 py-3.5 text-foreground`;

/** A bot message bubble sized to its content length and stack position. */
export const botMessageBubble = (long: boolean, stack: BubbleStackPosition = "single") =>
  `${baseShape} max-w-full bg-chat-bubble ${bubblePadding(long)} text-foreground ${stackCorners("bot", stack)}`;

/**
 * Another bot's message to this one: input, so on the person's side, drawn in outline on the
 * page rather than filled in the accent, so it is never taken for theirs.
 */
export const inputBubble = `${baseShape} ${bubbleWidth.mine} border border-border bg-transparent px-3.5 py-2.5 text-foreground dark:border-border-strong`;

export const inputMessageBubble = (long: boolean, stack: BubbleStackPosition = "single") =>
  `${baseShape} max-w-full border border-border bg-transparent ${bubblePadding(long)} text-foreground dark:border-border-strong ${stackCorners("mine", stack)}`;

/** The person's words: a pill in the bot's or club's colour (`--chat-mine`). */
export const mineBubble = `${baseShape} ${bubbleWidth.mine} bg-chat-mine px-3.5 py-2.5 text-chat-mine-foreground`;

export const mineMessageBubble = (long: boolean, stack: BubbleStackPosition = "single") =>
  `${baseShape} max-w-full bg-chat-mine ${bubblePadding(long)} text-chat-mine-foreground ${stackCorners("mine", stack)}`;

/** A bubble inside `BubbleFrame`, which holds its width limit: it may fill the frame. */
export const framed = "max-w-full";

/**
 * Derive `--chat-mine` and its readable label/meta/code tokens from `--agent-accent-*`,
 * clamping lightness so pastel bot colours render as rich, legible dark- and light-mode pills.
 */
export const botMinePalette =
  "[--chat-mine:oklch(from_var(--agent-accent-light)_min(l,0.56)_c_h)] dark:[--chat-mine:oklch(from_var(--agent-accent-dark)_min(l,0.55)_c_h)] [--chat-mine-foreground:oklch(from_var(--chat-mine)_clamp(0,calc((0.7-l)*1000),1)_0_0)] [--chat-mine-meta:color-mix(in_oklab,var(--chat-mine-foreground)_72%,transparent)] [--chat-mine-code:color-mix(in_oklab,var(--chat-mine-foreground)_14%,transparent)]";
