// oxlint-disable react/no-array-index-key -- a message's segments are ordered runs of one string.
import type { ContentPart } from "@ace/protocol";
import { useEffect, useId, useState, type Ref } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { cn } from "@/lib/cn.ts";
import { MessageReferences } from "./message-references.tsx";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import {
  bubbleSegments,
  isLongMessage,
  looksLikeMarkdown,
  personFold,
  withHardBreaks,
  type BubbleFold,
} from "@ace/ui-core";

/** Prose lines are `text-prose`'s 1.6; the fold keeps `fold.shown` of them, the last fading. */
const lineEm = 1.6;
const foldStyle = (fold: BubbleFold, markdown: boolean) => ({
  maxHeight: `${fold.shown * lineEm}em`,
  // A short fold, or rendered markdown, fades only its last line; a long plain fold fades two.
  maskImage: `linear-gradient(to bottom, #000 calc(100% - ${fold.shown > 4 && !markdown ? 3.2 : 1.6}em), transparent)`,
});

/**
 * Whether the rendered content is taller than the fold, measured as it draws (rendered markdown
 * changes height as markit paints it). Undefined where nothing is laid out yet, so the text's own
 * length decides.
 */
function useTallerThanFold(fold: BubbleFold, measure: boolean) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [taller, setTaller] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!measure || !node || typeof ResizeObserver === "undefined") return;
    const check = () => {
      const size = Number.parseFloat(getComputedStyle(node).fontSize) || 16;
      const height = node.scrollHeight;
      if (height > 0) setTaller(height > fold.shown * lineEm * size + 1);
    };
    const observer = new ResizeObserver(check);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    check();
    return () => observer.disconnect();
  }, [fold, measure, node]);
  return [setNode, taller] as const;
}

/**
 * The words inside the person's bubble. Markdown a writer meant (`looksLikeMarkdown`) renders
 * through markit as answers do, sized for the bubble, with every line break kept; anything else
 * is prose as typed, fenced blocks (or a paste that is plainly code) in monospace on the code
 * surface, mentions as chips. Nothing is wider than the bubble: long words wrap anywhere, code
 * and tables scroll inside it. A long message shows its first lines under a fade, with
 * "Show more" / "Show less" at the bubble's foot; rendered markdown folds by its drawn height.
 * A message another thread's agent sent passes its own shorter `fold`; its button carries a
 * caret, since most of such a brief is hidden.
 */
export function BubbleText({
  text,
  parts,
  ref,
  fold,
}: {
  text: string;
  parts?: readonly ContentPart[] | undefined;
  /** The readable content, for Copy; the fold button stays outside it. */
  ref?: Ref<HTMLDivElement> | undefined;
  fold?: BubbleFold | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shape = fold ?? personFold;
  const mentions = parts?.some((part) => part.type === "mention");
  const markdown = !mentions && looksLikeMarkdown(text);
  const [measureNode, taller] = useTallerThanFold(shape, markdown);
  const long = taller ?? isLongMessage(text, shape);
  const folded = long && !open;
  return (
    <>
      <div
        id={id}
        ref={ref}
        data-folded={folded || undefined}
        style={folded ? foldStyle(shape, markdown) : undefined}
        className={cn("min-w-0", folded && "overflow-hidden")}
      >
        <div ref={measureNode} className="min-w-0">
          {markdown ? (
            <Prose text={withHardBreaks(text)} className="ace-bubble-prose" />
          ) : mentions && parts ? (
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
            {fold &&
              (open ? (
                <CaretUpIcon aria-hidden size={12} />
              ) : (
                <CaretDownIcon aria-hidden size={12} />
              ))}
          </Button>
        </div>
      )}
    </>
  );
}
