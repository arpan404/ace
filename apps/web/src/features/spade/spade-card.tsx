import { ClockIcon, HandIcon, QuestionIcon } from "@ace/icons";
import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { createContext, useContext, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeFace } from "./spade-face.tsx";

/*
 * The chat's surfaces (docs/design/spade.md, "Conversation"): the bot's words in a soft fill with
 * no edge; the person's in the accent; and, raised with an edge and a lift, only what needs the
 * person now (an open question or request). Answered, a card settles into ordinary bubbles or one
 * quiet line.
 */

/** A bubble is at most 600px, and never wider than its column however long a word it holds. */
export const botBubble =
  "min-w-0 max-w-[min(100%,--spacing(150))] rounded-lg bg-chat-bubble px-4 py-2.5 font-prose text-prose leading-[1.5] wrap-anywhere";

/** A skill's bubble: the bot's bubble, its words at control size. */
export const quietBubble =
  "min-w-0 max-w-[min(100%,--spacing(150))] rounded-lg bg-chat-bubble px-3 py-2 wrap-anywhere";

export const personBubble =
  "min-w-0 max-w-[80%] rounded-lg bg-chat-mine px-3 text-chat-mine-foreground py-2 font-prose text-prose leading-[1.5] wrap-anywhere";

/**
 * A card that waits on the person: raised, its parts 16px apart, its actions in a footer. A Suit
 * reaches it as `card` `waiting`, by what it asks: `spade-question` or `spade-request`.
 */
export function RaisedCard(
  props: React.ComponentProps<"div"> & {
    asks: "question" | "request";
    children: ReactNode;
    className?: string;
  },
) {
  const { asks, className, children, ...rest } = props;
  return (
    <div
      {...rest}
      {...part("card", "waiting", `spade-${asks}`)}
      className={cn(
        // Focused when the chat opens on it, for screen readers: a target, not a control, so
        // no ring (its own buttons keep theirs).
        "@container/card my-2 flex w-full max-w-150 min-w-0 flex-col gap-4 rounded-(--chat-bubble-radius) bg-chat-raised p-5 shadow-chat-raised outline-none pointer-coarse:p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

const glyphs = { question: QuestionIcon, request: HandIcon };

/**
 * Whose card it is: the bot's face, given by the conversation the card sits in. A card outside a
 * conversation (first run, a settings page) has none and leads with its needs-you mark instead.
 */
export const CardFace = createContext<SpadeAvatar | undefined>(undefined);

/**
 * A card's first line: who asks (the bot's small face, else the amber needs-you mark) and one
 * sentence, with what pages it on the right. Everything under it starts at the card's own left
 * edge, the face's, so the card reads as one column.
 */
export function NeedsYouLine(props: {
  glyph: keyof typeof glyphs;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const face = useContext(CardFace);
  const Glyph = glyphs[props.glyph];
  return (
    <div className="flex min-w-0 items-start gap-2.5 font-prose text-prose leading-[1.5]">
      {face ? (
        <SpadeFace avatar={face} size={24} className="mt-px" />
      ) : (
        <Glyph aria-hidden weight="bold" className="mt-1 size-4 shrink-0 text-status-needs-you" />
      )}
      <div className="min-w-0 flex-1 font-medium">{props.children}</div>
      {props.aside && <div className="-mt-0.5 -mr-1.5 shrink-0">{props.aside}</div>}
    </div>
  );
}

/** What a card holds under its first line, on the card's one left edge. */
export function CardBody(props: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-3">{props.children}</div>;
}

/** Why it asks, in one quiet line under what it shows. */
export function CardWhy(props: { children: ReactNode }) {
  return <p className="text-ui leading-5 text-muted-foreground">{props.children}</p>;
}

/**
 * A raised card's footer: its answers together on the right, in one row, the quieter ones as
 * words before its one accent pill (its key hint only where it fits, `cardKeyHint`). What isn't an
 * answer (Later, a page count) can sit on the left, as `aside`.
 */
export function CardFooter(props: { start: ReactNode; end: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {props.aside && <div className="-ml-3.5 flex items-center gap-1">{props.aside}</div>}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
        {props.start}
        {props.end}
      </div>
    </div>
  );
}

/** A card's buttons are pills. */
const pill = "h-(--spade-pill-button) rounded-full px-3.5 text-ui";

/** A card's quieter answer, in words: Answer later, Never mind, Deny, Always allow. */
export function CardWord(props: React.ComponentProps<typeof Button>) {
  const { className, ...rest } = props;
  return <Button {...rest} variant="ghost" className={cn(pill, "hover:bg-hover", className)} />;
}

/** A card's one accent action: Send, Next, Allow, Yes. */
export function CardPrimary(props: React.ComponentProps<typeof Button>) {
  const { className, ...rest } = props;
  return <Button {...rest} variant="primary" className={cn(pill, "gap-2", className)} />;
}

/** The other answer beside a card's primary, outlined: No beside Yes. */
export function CardSecondary(props: React.ComponentProps<typeof Button>) {
  const { className, ...rest } = props;
  return (
    <Button
      {...rest}
      variant="secondary"
      className={cn(pill, "shadow-[inset_0_0_0_1px_var(--border-strong)]", className)}
    />
  );
}

/** A key hint on a card's accent pill: quieter than its word, dropped in a card too narrow. */
export const cardKeyHint = "font-normal opacity-60 @max-[20rem]/card:hidden";

/**
 * A settled card or one left for later, as one quiet line in the run: a word for how it stands
 * (or the clock, for later), then what it was, cut to the line.
 */
export const settledLine =
  "ml-3 flex min-w-0 max-w-[calc(100%-0.75rem)] items-baseline gap-2 text-ui leading-5 text-muted-foreground";

export function LaterClock() {
  return <ClockIcon aria-hidden className="size-4 shrink-0 self-center" />;
}
