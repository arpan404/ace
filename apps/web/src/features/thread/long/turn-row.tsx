import { useItem } from "@ace/client-react";
import { asSentence, digestFacts, oneLine, turnHeadline, turnSpan } from "@ace/ui-core";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useNow } from "@/lib/time.ts";
import { DigestFacts } from "./digest-facts.tsx";
import { useTurnSummary } from "./turn-index.ts";

function useAsk(threadId: string, askId: string | undefined): string | undefined {
  const item = useItem(threadId, askId ?? "");
  if (item?.type !== "message") return undefined;
  return oneLine(item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" "));
}

/**
 * An older turn folded to one line: its number, the ask that started it, its digest and how
 * long it ran. The digest comes from the turn index as the row scrolls into view; until then
 * the row shows what the loaded items say.
 */
export function FoldedTurn(props: {
  threadId: string;
  ordinal: number;
  askId: string | undefined;
  onOpen(): void;
}) {
  const ask = useAsk(props.threadId, props.askId);
  const summary = useTurnSummary(props.threadId, props.ordinal);
  const now = useNow();
  const headline = ask || (summary ? turnHeadline(summary) : "Turn without a message in view");
  const facts = summary ? digestFacts(summary.digest) : [];
  return (
    <button
      type="button"
      aria-expanded={false}
      aria-label={`Turn ${props.ordinal}: ${asSentence(headline)} Show the turn`}
      onClick={props.onOpen}
      className="group -mx-1.5 flex h-8 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
    >
      <CaretRightIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      <span className="shrink-0 font-mono text-xs tabular-nums text-subtle-foreground">
        {props.ordinal}
      </span>
      <span className="min-w-0 flex-1 truncate">{headline}</span>
      <DigestFacts facts={facts} className="max-w-[44ch] shrink text-xs text-subtle-foreground" />
      {summary && (
        <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">
          {turnSpan(summary, now)}
        </span>
      )}
    </button>
  );
}

/** The header of an older turn the reader opened: folds it again. */
export function OpenTurnHead(props: { ordinal: number; onFold(): void }) {
  return (
    <button
      type="button"
      aria-expanded
      aria-label={`Turn ${props.ordinal}. Fold the turn`}
      onClick={props.onFold}
      className="group -mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 text-xs text-subtle-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
    >
      <CaretDownIcon aria-hidden size={12} className="shrink-0" />
      <span className="font-mono tabular-nums">Turn {props.ordinal}</span>
    </button>
  );
}
