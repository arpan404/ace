import { looksLikeMarkdown, withHardBreaks } from "@ace/ui-core";
import { memo } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { cn } from "@/lib/cn.ts";
import "./spade-prose.css";

/** Whose bubble the words sit in: code takes that bubble's well. */
export type BubbleSide = "bot" | "mine";

/**
 * A message's words as a bubble shows them (ADR 0127), through markit, the renderer every answer
 * in ace uses: paragraphs, headings, nested lists, quotes, aligned tables and code with its
 * colours and Copy, with no mark ever showing as written, even halfway through a stream. A reply
 * still arriving (`streaming`) reaches the renderer at its pace, so the bubble grows a few times a
 * second, not on every word. In a bot's bubble code sits in the `--chat-code` well, hung 6px in
 * from the bubble's edge (`spade-prose.css`). The person's words render as markdown only where
 * they meant it (a fence, a list, a link…); anything else stays exactly as typed.
 */
export const SpadeBubbleText = memo(function SpadeBubbleText(props: {
  text: string;
  side?: BubbleSide;
  /** The bubble's own name, the same while it streams and once it is done. */
  stream?: string | undefined;
  /** Its words are still arriving. */
  streaming?: boolean | undefined;
}) {
  const side = props.side ?? "bot";
  if (side === "mine" && !looksLikeMarkdown(props.text))
    return <p className="whitespace-pre-wrap">{props.text}</p>;
  return (
    <Prose
      text={side === "mine" ? withHardBreaks(props.text) : props.text}
      stream={props.stream}
      streaming={props.streaming}
      className={cn("ace-spade-prose", side === "mine" && "ace-spade-prose-mine")}
    />
  );
});
