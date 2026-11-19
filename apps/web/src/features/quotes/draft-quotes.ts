import { formatMessageQuotes, messageQuoteLimit, type MessageQuote } from "@ace/ui-core";
import type { ContentPart } from "@ace/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { publishQuotes } from "./store.ts";

/** What a message being sent takes from the draft's quotes. */
export interface QuotesHandOff {
  /** The `<replying_to>` block, as the text part before the person's words. */
  part: ContentPart;
  /** The quotes as a draft keeps them, for a message that comes back. */
  returned: readonly MessageQuote[];
}

const without =
  (id: string) =>
  (now: readonly MessageQuote[]): readonly MessageQuote[] =>
    now.filter((entry) => entry.id !== id);

/**
 * The passages of the agent's messages the message being written replies to. The thread's
 * transcript adds them through the published port (an existing thread only: a new thread's
 * draft has no transcript).
 */
export function useDraftQuotes(options: {
  threadId: string | undefined;
  restored: readonly MessageQuote[] | undefined;
  focus(): void;
}) {
  const [quotes, setQuotes] = useState<readonly MessageQuote[]>(options.restored ?? []);
  const focus = useRef(options.focus);
  useLayoutEffect(() => {
    focus.current = options.focus;
  });
  const { threadId } = options;
  useLayoutEffect(() => {
    if (!threadId) return;
    return publishQuotes(threadId, {
      full: quotes.length >= messageQuoteLimit,
      add: (quote) => setQuotes((now) => (now.length < messageQuoteLimit ? [...now, quote] : now)),
      focus: () => focus.current(),
    });
  }, [threadId, quotes.length]);
  return {
    /** The quotes as the stored draft keeps them. */
    draft: quotes.length ? quotes : undefined,
    count: quotes.length,
    quotes,
    remove: (id: string) => setQuotes(without(id)),
    /** Take another window's or a returned message's quotes as they are. */
    replace: (next: readonly MessageQuote[] | undefined) => setQuotes(next ?? []),
    /** The block for a message being sent; the draft lets its quotes go. */
    handOff: (): QuotesHandOff | undefined => {
      const block = formatMessageQuotes(quotes);
      if (!block) return undefined;
      setQuotes([]);
      return { part: { type: "text", text: `${block}\n\n` }, returned: quotes };
    },
  };
}

export type DraftQuotesState = ReturnType<typeof useDraftQuotes>;
