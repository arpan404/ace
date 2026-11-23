/**
 * Spellings ace no longer has, kept for one release so the people and scripts that type them
 * are told where the work moved (ADR 0221 §1). They are not commands: nothing runs, and the
 * parser answers them with the app's name and exit 2, not a suggestion.
 */

export interface RetiredSpec {
  readonly words: readonly string[];
  readonly message: string;
  readonly hint: string;
}

const message = "Chat with agents in the ace app. The CLI manages ace.";

export const retired: readonly RetiredSpec[] = [
  { words: ["chat"], message, hint: "Open the ace app to talk with an agent, or ace help." },
  {
    words: ["thread", "attach"],
    message,
    hint: "Open the ace app to talk with an agent, or ace help thread.",
  },
  {
    words: ["spade", "chat"],
    message,
    hint: "Open the ace app's Spade to talk with a bot, or ace help spade.",
  },
];

/** The retired spelling `named` starts with, if any. Pure. */
export function retiredCommand(named: readonly string[]): RetiredSpec | undefined {
  return retired.find((spec) => spec.words.every((word, index) => named[index] === word));
}
