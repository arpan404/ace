import type { ParsedMessageQuote } from "@ace/ui-core";

/** What a sent message replied to, at the top of its bubble: each quoted passage set off by a rule. */
export function QuotesCard(props: { quotes: readonly ParsedMessageQuote[] }) {
  return (
    <ul aria-label="Replying to" className="flex flex-col gap-1 whitespace-normal">
      {props.quotes.map((quote) => (
        <li key={`${quote.context}\n${quote.text}`}>
          <blockquote className="line-clamp-3 border-l-2 border-border pl-2.5 text-ui whitespace-pre-wrap text-muted-foreground">
            {quote.text}
          </blockquote>
        </li>
      ))}
    </ul>
  );
}
