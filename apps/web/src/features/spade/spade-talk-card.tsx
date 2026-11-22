import { CaretRightIcon } from "@ace/icons";
import { formatClock } from "@ace/ui-core";
import type { SpadeAvatar, SpadeTalkCard, SpadeTalkRow } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeFace } from "./spade-face.tsx";

/*
 * A conversation card (docs/design/spade.md, "Talking with other bots"): the messages a bot sent
 * another bot in one turn with their replies, a contract call with what came back, or, in the
 * receiver's chat, a contract call it was given. It is the subagent card's shape: the bot's
 * bubble fill with no edge or lift, its first line the other bot's face and one sentence, then
 * one flat row per line said, under the face of whoever said it, hairlines between them that
 * start at the text, a quiet time and a caret. A row reads in one line and opens in place to
 * the whole of it; the first line's caret opens the other bot's chat. While a reply is owed its
 * row says who is on it, in the step's light, and the card never reads as finished. Its words
 * come from `@ace/ui-core/spade-chat` (`spadeTalkCard`, `spadeContractCard`). A Suit reaches it
 * as `card` `spade-talk`.
 */

export interface SpadeTalkFaces {
  self: SpadeAvatar;
  other: SpadeAvatar;
}

const tones: Record<SpadeTalkRow["tone"], string> = {
  quiet: "text-muted-foreground",
  working: "text-muted-foreground",
  failed: "text-(--status-failed-text)",
  settled: "text-foreground",
};

/**
 * The hairline above every row but the first, starting at the text (the face's 24px, its 10px
 * gap), as the subagent card draws it.
 */
const hairline =
  "not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-[34px] not-first:before:h-px not-first:before:bg-border dark:not-first:before:bg-border-strong";

export function SpadeTalkCardView(props: {
  card: SpadeTalkCard;
  faces: SpadeTalkFaces;
  /** The other bot's name, for the opener's label. */
  otherName: string;
  /** Opens the other bot's chat; none when it can't be opened from here. */
  onOpenOther: (() => void) | undefined;
}) {
  const { card } = props;
  return (
    <section
      {...part("card", card.pending ? "working" : undefined, "spade-talk")}
      aria-label={card.header}
      data-talk-pending={card.pending ? "" : undefined}
      className="@container/card flex w-full max-w-150 min-w-0 flex-col gap-4 rounded-(--chat-bubble-radius) bg-chat-bubble p-5 pointer-coarse:p-4"
    >
      <header className="flex min-w-0 items-start gap-2.5 font-prose text-prose leading-[1.5]">
        <SpadeFace avatar={props.faces.other} size={24} className="mt-px" />
        <h3 className="min-w-0 flex-1 font-medium text-foreground">{card.header}</h3>
        {props.onOpenOther && (
          <button
            type="button"
            aria-label={`Open ${props.otherName}`}
            onClick={props.onOpenOther}
            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-subtle-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring"
          >
            <CaretRightIcon aria-hidden size={14} />
          </button>
        )}
      </header>
      <ul aria-label="Messages" className="flex min-w-0 flex-col">
        {card.rows.map((row) => (
          <TalkRow
            key={row.key}
            row={row}
            face={row.from === "self" ? props.faces.self : props.faces.other}
          />
        ))}
      </ul>
    </section>
  );
}

function TalkRow(props: { row: SpadeTalkRow; face: SpadeAvatar }) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  // The live wait has nothing more to show; every other line opens to the whole of it.
  const opens = !row.live && row.text.length > 0;
  return (
    <li
      data-talk-from={row.from}
      data-talk-tone={row.tone}
      className={cn("group/row relative min-w-0", hairline)}
    >
      <div className="relative -mx-2 flex min-h-11 min-w-0 items-start gap-2.5 rounded-lg px-2 py-2.5 transition-colors duration-(--motion-fast) group-hover/row:bg-hover">
        {opens && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Show less" : "Show all of it"}
            onClick={() => setOpen(!open)}
            className="absolute inset-0 rounded-lg focus-ring"
          />
        )}
        <span
          aria-hidden
          className={cn("grid h-5 w-6 shrink-0 place-items-center", row.live && "fx-live-dot")}
        >
          <SpadeFace avatar={props.face} size={18} />
        </span>
        <p
          // A new phrase sweeps once in the step's light, as the chat's Working line does.
          key={row.live ? row.text : undefined}
          className={cn(
            "min-w-0 flex-1 text-base leading-5",
            open ? "break-words whitespace-pre-wrap" : "truncate",
            tones[row.tone],
            row.live && "step-shimmer",
          )}
        >
          {row.text}
        </p>
        <span className="flex h-5 shrink-0 items-center gap-1.5">
          {row.at !== undefined && row.at > 0 && (
            <span className="text-xs text-subtle-foreground tabular-nums">
              {formatClock(row.at)}
            </span>
          )}
          {opens && (
            <CaretRightIcon
              aria-hidden
              size={14}
              className={cn(
                "shrink-0 text-subtle-foreground transition-[color,rotate] duration-(--motion-fast) group-hover/row:text-foreground",
                open && "rotate-90",
              )}
            />
          )}
        </span>
      </div>
    </li>
  );
}
