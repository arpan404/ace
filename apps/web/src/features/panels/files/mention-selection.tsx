import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import type { Mention } from "@ace/protocol";

const lineOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-line]");
function selectedLines(root: HTMLElement): Mention["lines"] {
  // The editor publishes its own selection: it draws carets over the text, so a native DOM
  // selection never forms. Plain viewers fall back to the browser's selection below.
  const published = root.querySelector<HTMLElement>("[data-selected-lines]")?.dataset.selectedLines;
  if (published) {
    const [start, end] = published.split("-").map(Number);
    if (start && end) return { start, end };
  }
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
  const first = lineOf(selection.anchorNode),
    last = lineOf(selection.focusNode);
  if (!first || !last || !root.contains(first) || !root.contains(last)) return;
  const a = Number(first.dataset.line) + 1,
    b = Number(last.dataset.line) + 1;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
export function MentionSelection(props: {
  path: string;
  onMention(mention: Mention): void;
  children: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Mention["lines"]>();
  const read = () => {
    if (root.current) setLines(selectedLines(root.current));
  };
  return (
    <div
      ref={root}
      role="presentation"
      onMouseUp={read}
      onKeyUp={read}
      className={cn("relative", props.className)}
    >
      {lines && (
        // Over the code's top right corner, so the text never moves when a selection forms.
        <div className="ace-floating-solid absolute top-1.5 right-3 z-10 rounded-popup shadow-glass">
          <Button
            size="sm"
            variant="ghost"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              props.onMention({ path: props.path, lines });
              setLines(undefined);
            }}
          >
            Mention selection ·{" "}
            {lines.start === lines.end
              ? `line ${lines.start}`
              : `lines ${lines.start}–${lines.end}`}
          </Button>
        </div>
      )}
      {props.children}
    </div>
  );
}
