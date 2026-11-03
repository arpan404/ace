import { XIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { DraftQuotesState } from "./draft-quotes.ts";

/**
 * What the message being written replies to, above the words: each quoted passage of the
 * agent's messages set off by a rule, with × to drop it.
 */
export function ReplyQuotes(props: { quotes: DraftQuotesState }) {
  const { quotes } = props;
  if (!quotes.count) return null;
  return (
    <ul aria-label="Replying to" className="flex flex-col gap-1.5 px-4 pt-3">
      {quotes.quotes.map((quote) => (
        <li key={quote.id} className="flex min-w-0 items-start gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 border-l-2 border-border pl-2.5 text-ui wrap-break-word whitespace-pre-wrap text-muted-foreground">
            {quote.text}
          </p>
          <IconButton
            icon={XIcon}
            label="Remove quote"
            size="sm"
            tooltip={false}
            onClick={() => quotes.remove(quote.id)}
          />
        </li>
      ))}
    </ul>
  );
}
