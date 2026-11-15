import type { ReactNode } from "react";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * The chat's surfaces (DESIGN.md, "Conversations"): the bot's words in a soft fill with no edge;
 * the person's a step stronger; and, raised with an edge and a lift, only what needs the person
 * now (an open question or request). Answered, a card settles flat into an ordinary bubble.
 */

/** A bubble is at most 600px, and never wider than its column however long a word it holds. */
export const botBubble =
  "min-w-0 max-w-[min(100%,--spacing(150))] rounded-lg bg-chat-bubble px-4 py-2.5 font-prose text-prose leading-[1.5] wrap-anywhere";

/** A settled card or a one-line request: the bot's bubble, its words at control size. */
export const quietBubble =
  "min-w-0 max-w-[min(100%,--spacing(150))] rounded-lg bg-chat-bubble px-3 py-2 wrap-anywhere";

export const personBubble =
  "min-w-0 max-w-[80%] rounded-lg bg-chat-mine px-3 py-2 font-prose text-prose leading-[1.5] wrap-anywhere";

/** A card that waits on the person: raised, with its actions in a footer. */
export function RaisedCard(
  props: React.ComponentProps<"div"> & { children: ReactNode; className?: string },
) {
  const { className, children, ...rest } = props;
  return (
    <div
      {...rest}
      className={cn(
        "@container/card my-2 w-full max-w-140 min-w-0 rounded-xl bg-chat-raised p-5 shadow-chat-raised focus-ring pointer-coarse:p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A card's first line: the one amber mark that it needs the person, then its words. Only an
 * open card carries the mark.
 */
export function NeedsYouLine(props: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="relative flex min-w-0 items-start gap-2 pl-6 font-prose text-prose leading-[1.5]">
      <StatusGlyph state="needs-you" size={16} className="absolute top-1 left-0" />
      <div className="min-w-0 flex-1">{props.children}</div>
      {props.aside && <div className="-my-0.5 -mr-1.5 shrink-0">{props.aside}</div>}
    </div>
  );
}

/**
 * A raised card's footer, on one line: the quieter answers as words on the left, where the
 * card's text starts, and its one ink action on the right (its key hint only where it fits,
 * `cardKeyHint`).
 */
export function CardFooter(props: { start: ReactNode; end: ReactNode }) {
  return (
    <div className="mt-5 flex items-center gap-1 pointer-coarse:mt-4">
      <div className="-ml-2.5 flex items-center gap-1">{props.start}</div>
      <div className="ml-auto flex items-center gap-1">{props.end}</div>
    </div>
  );
}

/** A key hint on a card's ink action: dropped in a card too narrow for it. */
export const cardKeyHint = "ml-1.5 @max-[20rem]/card:hidden";
