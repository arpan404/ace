import type { ContentPart } from "@ace/protocol";

/*
 * Replying to part of what an agent said: the passages the person quoted from its messages, how
 * a draft keeps them, the block the agent reads before the person's words, and that block read
 * back for the sent bubble and for Edit. Pure.
 */

/** A passage of an agent message the person is replying to. */
export interface MessageQuote {
  id: string;
  /** The words as the person saw and selected them. */
  text: string;
  /** A little of the message on either side, so the agent can place the passage. */
  before: string;
  after: string;
}

/** At most this many passages in one message. */
export const messageQuoteLimit = 10;
/** Context kept on each side of a passage. */
export const quoteContextChars = 80;

/**
 * The words of a selection as a passage: line ends unified, trailing spaces dropped, runs of
 * blank lines kept to one; undefined when it holds no words.
 */
export function passageText(selected: string): string | undefined {
  const text = selected
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}

const open = '<replying_to version="1">';
const close = "</replying_to>";
const preamble = (count: number) =>
  [
    count === 1
      ? "The person's message below replies to this part of one of your earlier messages in this thread."
      : "The person's message below replies to these parts of your earlier messages in this thread.",
    "Each passage quotes your own words as the person saw them; the text around it shows where it is.",
  ].join("\n");

/** Person and message text can never open or close the block it sits in. */
const neutral = (value: string) => value.replace(/<(\/?)replying_to/gi, "<$1replying-to");
const quoted = (value: string) => neutral(JSON.stringify(value));
const collapse = (value: string) => value.replace(/\s+/g, " ");

/** "…before passage after…", with an ellipsis only where the message was cut short. */
function inContext(quote: MessageQuote): string {
  const cutBefore = quote.before.length >= quoteContextChars;
  const cutAfter = quote.after.length >= quoteContextChars;
  const before = collapse(quote.before).trimStart();
  const after = collapse(quote.after).trimEnd();
  return `${cutBefore ? "…" : ""}${before}${collapse(quote.text)}${after}${cutAfter ? "…" : ""}`;
}

/** The block the agent reads before the person's words, or nothing without passages. */
export function formatMessageQuotes(quotes: readonly MessageQuote[]): string | undefined {
  const kept = quotes.slice(0, messageQuoteLimit);
  if (!kept.length) return undefined;
  const items = kept.map((quote, index) =>
    [
      `${kept.length > 1 ? `[${index + 1}] ` : ""}Passage: ${quoted(quote.text)}`,
      `In context: ${quoted(inContext(quote))}`,
    ].join("\n"),
  );
  return [open, preamble(kept.length), "", items.join("\n\n"), close].join("\n");
}

/** A passage as read back from a sent block. */
export interface ParsedMessageQuote {
  text: string;
  context: string;
}

const blockPattern = /<replying_to version="1">[\s\S]*?<\/replying_to>/;
const itemPattern =
  /^(?:\[\d{1,2}\] )?Passage: ("(?:[^"\\]|\\.)*")\nIn context: ("(?:[^"\\]|\\.)*")$/gm;

function json(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The person's text without the block, and the block's passages when it holds any. */
export function splitMessageQuotes(text: string): {
  text: string;
  quotes?: ParsedMessageQuote[] | undefined;
} {
  const match = blockPattern.exec(text);
  if (!match) return { text };
  const quotes: ParsedMessageQuote[] = [];
  for (const item of match[0].matchAll(itemPattern)) {
    const words = item[1] && json(item[1]);
    const around = item[2] && json(item[2]);
    if (words === undefined || around === undefined) continue;
    quotes.push({ text: words, context: around });
  }
  if (!quotes.length) return { text };
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`;
  return { text: rest.trim(), quotes };
}

/** A message's parts without the block (an empty text part it leaves is dropped), and its passages. */
export function splitQuoteParts(parts: readonly ContentPart[]): {
  parts: ContentPart[];
  quotes?: ParsedMessageQuote[] | undefined;
} {
  let quotes: ParsedMessageQuote[] | undefined;
  const kept: ContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "text" || quotes) {
      kept.push(part);
      continue;
    }
    const split = splitMessageQuotes(part.text);
    if (!split.quotes) {
      kept.push(part);
      continue;
    }
    quotes = split.quotes;
    if (split.text.trim()) kept.push({ ...part, text: split.text });
  }
  if (!kept.length && quotes) kept.push({ type: "text", text: "" });
  return { parts: kept, quotes };
}

/** Passages rebuilt from a sent block for Edit, with the words around them. */
export function returnedQuotes(
  parsed: readonly ParsedMessageQuote[],
  id: (index: number) => string,
): MessageQuote[] {
  return parsed.map((quote, index) => {
    const context = quote.context.replace(/^…/, "").replace(/…$/, "");
    const words = collapse(quote.text);
    const at = context.indexOf(words);
    return {
      id: id(index),
      text: quote.text,
      before: at > 0 ? context.slice(0, at) : "",
      after: at >= 0 ? context.slice(at + words.length) : "",
    };
  });
}

/** Two lists of passages together, without repeating one. */
export function mergeQuotes(
  current: readonly MessageQuote[] | undefined,
  returned: readonly MessageQuote[] | undefined,
): MessageQuote[] | undefined {
  if (!returned?.length) return current?.length ? [...current] : undefined;
  const ids = new Set(current?.map((quote) => quote.id));
  const merged = [...(current ?? []), ...returned.filter((quote) => !ids.has(quote.id))];
  return merged.slice(0, messageQuoteLimit);
}
