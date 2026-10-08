import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { Mention } from "@ace/protocol";

const lineOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-line]");
function selectedLines(root: HTMLElement): Mention["lines"] {
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
}) {
  const root = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Mention["lines"]>();
  const read = () => {
    if (root.current) setLines(selectedLines(root.current));
  };
  return (
    <div ref={root} onMouseUp={read} onKeyUp={read}>
      {lines && (
        <div className="sticky top-0 z-10 flex h-8 items-center justify-end bg-background px-3">
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
