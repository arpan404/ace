import type { ContentPart } from "@ace/protocol";
import { formatMessageQuotes, messageQuoteLimit, quoteIn, type MessageQuote } from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * Replying to part of what an agent said, the phone's side of the web's draft quotes: the
 * passages of the agent's messages the open thread's next message replies to, each picked from a
 * selection in the message's words (`quoteIn` in `@ace/ui-core`). Swift draws them as a chip
 * over the composer; on send they become the `<replying_to>` block before the person's words.
 * As the web's draft keeps them, a thread's quotes outlast a visit to it (`QuoteShelf`).
 */

/** Each thread's quotes, for the bridge's life; past `limit` threads the oldest is let go. */
export class QuoteShelf {
  readonly #drafts = new Map<string, readonly MessageQuote[]>();
  readonly #limit: number;
  constructor(limit = 50) {
    this.#limit = limit;
  }
  get(threadId: string): readonly MessageQuote[] {
    return this.#drafts.get(threadId) ?? [];
  }
  set(threadId: string, quotes: readonly MessageQuote[]): void {
    this.#drafts.delete(threadId);
    if (!quotes.length) return;
    this.#drafts.set(threadId, quotes);
    for (const oldest of this.#drafts.keys()) {
      if (this.#drafts.size <= this.#limit) break;
      this.#drafts.delete(oldest);
    }
  }
}

/** What `send` takes from the draft's quotes. */
export interface QuoteHandOff {
  /** The `<replying_to>` block, as the text part before the person's words. */
  part: ContentPart;
  /** The quotes it holds: only these leave once the message is saved. */
  ids: string[];
}

export class ThreadQuotes {
  readonly #shelf: QuoteShelf;
  readonly #threadId: string;
  readonly #emit: (patch: Record<string, unknown>) => void;
  readonly #id: () => string;
  readonly #preview: Preview;
  constructor(
    shelf: QuoteShelf,
    threadId: string,
    emit: (patch: Record<string, unknown>) => void,
    id: () => string,
    preview: Preview,
  ) {
    this.#shelf = shelf;
    this.#threadId = threadId;
    this.#emit = emit;
    this.#id = id;
    this.#preview = preview;
    this.resend();
  }
  get count(): number {
    return this.#quotes.length;
  }
  /** The words between `start` and `end` of an agent's message; nothing without words or room. */
  add(message: string, start: number, end: number): void {
    if (this.#quotes.length >= messageQuoteLimit) return;
    const quote = quoteIn(message, start, end);
    if (!quote) return;
    this.#set([...this.#quotes, { ...quote, id: this.#id() }]);
  }
  remove(id: string): void {
    this.#set(this.#quotes.filter((quote) => quote.id !== id));
  }
  clear(): void {
    this.#set([]);
  }
  /** The block for a message being sent; undefined without quotes. */
  handOff(): QuoteHandOff | undefined {
    const block = formatMessageQuotes(this.#quotes);
    if (!block) return undefined;
    return {
      part: { type: "text", text: `${block}\n\n` },
      ids: this.#quotes.map((quote) => quote.id),
    };
  }
  /** The message went: its quotes leave the draft; any picked since stay for the next one. */
  sent(handOff: QuoteHandOff): void {
    const gone = new Set(handOff.ids);
    this.#set(this.#quotes.filter((quote) => !gone.has(quote.id)));
  }

  get #quotes(): readonly MessageQuote[] {
    return this.#shelf.get(this.#threadId);
  }
  #set(quotes: readonly MessageQuote[]): void {
    this.#shelf.set(this.#threadId, quotes);
    this.resend();
  }
  /** Say the draft's quotes again: a snapshot of the thread replaces what native was told. */
  resend(): void {
    const quotes = this.#quotes;
    this.#emit({
      type: "thread.quotes",
      items: quotes.map((quote) => ({ id: quote.id, text: this.#preview(quote.text, 512) })),
      full: quotes.length >= messageQuoteLimit,
    });
  }
}

/** What the message replies to reads first, then the person's words. */
export function withQuotes(input: ContentPart[], handOff: QuoteHandOff | undefined): ContentPart[] {
  return handOff ? [handOff.part, ...input] : input;
}
