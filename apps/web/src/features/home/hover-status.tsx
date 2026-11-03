import type { ThreadListEntry } from "@ace/protocol";
import {
  hoverStatusLine,
  rowStatusLook,
  threadLiveFact,
  type RowAttention,
  type ThreadCard,
} from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { LookIcon, RowWake, RowWoke } from "./row-parts.tsx";

/** The words take the state's text colour (`--tone-text`, AA on every surface) when coloured. */
const inkTone = { warning: "needs-you", destructive: "failed", muted: undefined } as const;

/**
 * The hover card's first line under the title: what the thread waits on, in plain words
 * (`hoverStatusLine`), then what it is about when the thread list knows it (a step, a command in
 * mono), up to two lines. The row's own icon leads it, in the state's colour; the words are
 * coloured only when it needs the person or just failed. Nothing for a thread at rest; a snoozed
 * one says what it waits for, one back from a snooze why it woke.
 */
export function HoverStatus(props: {
  card: ThreadCard;
  entry: ThreadListEntry;
  attention: RowAttention;
}) {
  const { card, attention } = props;
  const { level } = attention;
  if (card.wake && level !== "needs-you" && level !== "failed") return <RowWake wake={card.wake} />;
  if (card.woke && level !== "needs-you" && level !== "failed") return <RowWoke woke={card.woke} />;
  const line = hoverStatusLine({ attention, card, fact: threadLiveFact(props.entry) });
  if (!line.sentence) return null;
  return (
    <div data-ink={line.ink} className="flex min-w-0 items-start gap-1.5 text-ui leading-5">
      <span className="flex h-5 shrink-0 items-center">
        <LookIcon look={rowStatusLook(attention, card)} />
      </span>
      <div className="min-w-0">
        <p
          data-tone={inkTone[line.ink]}
          className={
            line.ink === "muted" ? "text-muted-foreground" : "font-medium text-(--tone-text)"
          }
        >
          {line.sentence}
        </p>
        {line.detail && (
          <p
            className={cn(
              "line-clamp-2 break-words text-muted-foreground",
              line.detail.code && "font-mono text-meta",
            )}
          >
            {line.detail.text}
          </p>
        )}
      </div>
    </div>
  );
}
