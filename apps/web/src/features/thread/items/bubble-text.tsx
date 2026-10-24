// oxlint-disable react/no-array-index-key -- a message's segments are ordered runs of one string.
import type { ContentPart } from "@ace/protocol";
import { useId, useState, type Ref } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { MessageReferences } from "./message-references.tsx";
import { bubbleSegments, foldedLines, isLongMessage } from "@ace/ui-core";

/** Prose lines are `text-prose`'s 1.6; the fold keeps `foldedLines` of them, the last fading. */
const foldStyle = {
  maxHeight: `${foldedLines * 1.6}em`,
  maskImage: "linear-gradient(to bottom, #000 calc(100% - 3.2em), transparent)",
};

/**
 * The words inside the person's bubble: prose as typed, fenced blocks (or a paste that is plainly
 * code) in monospace on the code surface, mentions as chips. A long message shows its first ten
 * lines under a fade, with "Show more" / "Show less" at the bubble's foot.
 */
export function BubbleText({
  text,
  parts,
  ref,
}: {
  text: string;
  parts?: readonly ContentPart[] | undefined;
  /** The readable content, for Copy; the fold button stays outside it. */
  ref?: Ref<HTMLDivElement> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = isLongMessage(text);
  const folded = long && !open;
  const mentions = parts?.some((part) => part.type === "mention");
  return (
    <>
      <div
        id={id}
        ref={ref}
        data-folded={folded || undefined}
        style={folded ? foldStyle : undefined}
        className={cn(folded && "overflow-hidden")}
      >
        {mentions && parts ? (
          <MessageReferences parts={parts} />
        ) : (
          bubbleSegments(text).map((segment, index) =>
            segment.kind === "code" ? (
              <pre
                key={index}
                className="my-1 overflow-x-auto rounded-sm bg-code px-2 py-1.5 font-mono text-[0.92em] leading-[1.55] whitespace-pre first:mt-0 last:mb-0"
              >
                <code>{segment.text}</code>
              </pre>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )
        )}
      </div>
      {long && (
        <div className="-mb-1 flex justify-end pt-1">
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Show less" : "Show more"}
          </Button>
        </div>
      )}
    </>
  );
}
