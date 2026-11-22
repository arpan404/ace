import { z } from "zod";
import { spadeChatSegments } from "./chat-markup.ts";
import { spadePlainText } from "./markup.ts";

/*
 * Replying to a message (ADR 0212 §4). The person's reply carries what it quoted, as Spade stored
 * it with their message; the bot's names an earlier message by id (`<msg reply="m7">`), drawn
 * only when that message is in the same conversation and came before it.
 */

/** What a person's message quoted, as Spade stored it with the message. */
export interface SpadeReplyTo {
  /** The quoted message's id in its conversation (`m12`, `m12.2`). */
  id: string;
  text: string;
  /** The person quoted their own message. */
  mine: boolean;
  /** In a club, the member whose message it was. */
  name?: string | undefined;
}

/** A stored `reply_to`, read leniently: one this client can't read is no quote at all. */
export const spadeReplyToField = z
  .object({
    id: z.string().regex(/^m\d+(\.\d+)?$/),
    text: z.string().catch(""),
    mine: z.boolean().catch(false),
    name: z.string().min(1).optional().catch(undefined),
  })
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);

/** Who said a quoted message, as its line names them. */
export type SpadeQuoteWho = { kind: "person" } | { kind: "bot" } | { kind: "member"; name: string };

/** The small quoted line above a bubble: whose words, their first line, and where they are. */
export interface SpadeQuote {
  id: string;
  who: SpadeQuoteWho;
  text: string;
}

/** What the composer's strip shows while the person replies to a message. */
export type SpadeReplying = SpadeQuote;

/** A stored reply's quote. */
export function spadeQuoteOf(reply: SpadeReplyTo): SpadeQuote {
  return {
    id: reply.id,
    text: spadeQuoteLine(reply.text),
    who: reply.mine
      ? { kind: "person" }
      : reply.name
        ? { kind: "member", name: reply.name }
        : { kind: "bot" },
  };
}

const mostQuote = 140;

/** A message as one quoted line: its words without marks or markup, the first line, cut short. */
export function spadeQuoteLine(text: string): string {
  const words = spadeChatSegments(text)
    .map((segment) => segment.title ?? spadePlainText(segment.text))
    .join(" ");
  const line = words.split("\n").find((piece) => piece.trim() !== "") ?? "";
  const chars = [...line.trim()];
  return chars.length > mostQuote ? `${chars.slice(0, mostQuote - 1).join("")}…` : chars.join("");
}

/** The words naming who said it: "You", the bot's name, or the club member's. */
export function spadeQuoteName(who: SpadeQuoteWho, bot: string): string {
  if (who.kind === "person") return "You";
  if (who.kind === "member") return who.name;
  return bot;
}

/** The messages a chat has shown so far, by id: what a later reply may quote. */
export interface SpadeSaid {
  add(id: string, text: string, who: SpadeQuoteWho): void;
  /** The quote of an earlier message; undefined for an id not seen before (dropped silently). */
  quote(id: string): SpadeQuote | undefined;
  /** How many messages have been added. */
  readonly size: number;
  /** Forgets every message added after the first `size`, as if the chat stopped there. */
  truncate(size: number): void;
}

export function spadeSaid(): SpadeSaid {
  // In the order added; each row keeps where its id was before, should it be added again.
  const log: { id: string; text: string; who: SpadeQuoteWho; before: number | undefined }[] = [];
  // Each id's latest place in the log.
  const at = new Map<string, number>();
  return {
    add: (id, text, who) => {
      log.push({ id, text, who, before: at.get(id) });
      at.set(id, log.length - 1);
    },
    quote: (id) => {
      const place = at.get(id);
      const found = place === undefined ? undefined : log[place];
      return found && { id, who: found.who, text: spadeQuoteLine(found.text) };
    },
    get size() {
      return log.length;
    },
    truncate: (size) => {
      // Newest first, so an id added twice past `size` gets back its place before both.
      for (const row of log.splice(size).toReversed())
        if (row.before === undefined) at.delete(row.id);
        else at.set(row.id, row.before);
    },
  };
}
