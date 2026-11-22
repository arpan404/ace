/*
 * The words on a Spade Working line, as every client shows them. Spade says what the bot is doing
 * in its status (`spade_core::activity::doing`): the model's own headline, the step of its plan,
 * or what its tool does. Here that text, which came from a model, is made one short plain line,
 * plain "Thinking" or a tool's bare id reads "Working", and a new phrase waits until the last one
 * has been read. Pure.
 */

/** The most words a phrase keeps. */
export const spadePhraseWords = 6;
/** The most characters a phrase keeps. */
export const spadePhraseChars = 48;
/** The shortest time a phrase stays before the next one takes its place. */
export const spadePhraseHoldMs = 1200;

/** The line when nothing clearer can be said. */
export const spadeWorkingWord = "Working";

/** Words a cut phrase never ends on: "Reading the" reads as cut, "Reading" does not. */
const dangling = new Set(
  "a an the of to for in on and or with from by at its your my our their into about".split(" "),
);

/** Statuses that say nothing of what the bot does. */
const vague = new Set(["thinking", "running command", "running a command", "using a tool"]);

/**
 * A tool's id in words, from a server that doesn't know the tool ("Using frobnicate widgets"):
 * never on the line. Spade's own words start with an article ("Using an app on the screen").
 */
const bareTool = /^Using (?!an? |the |your )[a-z0-9 ]+$/;

/**
 * `text` as one short plain line: markdown marks and control characters gone, at most
 * `spadePhraseWords` words and `spadePhraseChars` characters, never ending on a dangling word.
 * Undefined when nothing is left.
 */
export function spadePlainPhrase(text: string): string | undefined {
  // oxlint-disable-next-line no-control-regex -- control characters are what it removes
  const plain = text.replace(/[*_`#>[\]~\u0000-\u001f\u007f]/g, " ");
  const all = plain.split(/\s+/).filter(Boolean);
  const words = all.slice(0, spadePhraseWords);
  while (words.join(" ").length > spadePhraseChars && words.length > 1) words.pop();
  if (all.length > words.length)
    while (words.length > 1 && dangling.has(words.at(-1)?.toLowerCase() ?? "")) words.pop();
  const line = words
    .join(" ")
    .replace(/[:,;.-]+$/, "")
    .trim()
    .slice(0, spadePhraseChars);
  return line ? line[0]?.toUpperCase() + line.slice(1) : undefined;
}

/**
 * The Working line's words for Spade's status: the status as a short plain line, or "Working"
 * while it says nothing of its own (none, plain "Thinking", a bare tool id).
 */
export function spadeWorkingPhrase(status: string | undefined): string {
  const line = status === undefined ? undefined : spadePlainPhrase(status);
  if (!line || vague.has(line.toLowerCase()) || bareTool.test(line)) return spadeWorkingWord;
  return line;
}

/** The phrase on the line and when it went up. */
export interface SpadeHeldPhrase {
  text: string;
  since: number;
}

/**
 * The phrase to show at `now` when `next` is the newest: the one shown stays until it has been up
 * `holdMs`, so a fast run of steps doesn't flicker. `recheckIn` is how long until `next` may take
 * its place, while it waits.
 */
export function spadeHoldPhrase(
  held: SpadeHeldPhrase | undefined,
  next: string,
  now: number,
  holdMs: number = spadePhraseHoldMs,
): { held: SpadeHeldPhrase; recheckIn: number | undefined } {
  if (!held || held.text === next)
    return { held: held ?? { text: next, since: now }, recheckIn: undefined };
  const shown = now - held.since;
  if (shown >= holdMs) return { held: { text: next, since: now }, recheckIn: undefined };
  return { held, recheckIn: holdMs - shown };
}
