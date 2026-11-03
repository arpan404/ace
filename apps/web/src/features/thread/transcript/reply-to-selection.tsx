import { selectionQuote } from "@ace/ui-core";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/cn.ts";
import { composerTakesText, insertTextInComposer } from "@/lib/composer-insert.ts";
import { frameThrottle } from "@/lib/frame-throttle.ts";
import { floatingControl, floatingHover } from "../long/floating.ts";

/** Agent prose the person can quote back in a reply (an answer, or words between steps). */
const quotable = "[data-quotable]";
/** The pill's height and the gap it keeps from the selected line. */
const pillRoom = 36;
const edge = 4;

interface Offer {
  quote: string;
  top: number;
  left: number;
}

function inQuotable(root: HTMLElement, node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  const hit = element?.closest(quotable);
  return !!hit && root.contains(hit);
}

/**
 * The person's selection in agent prose under `root`, quoted, and where its Reply goes in
 * `box`: over the selection's first line, or under its last when there is no room above.
 * Nothing when the selection leaves agent prose or is scrolled out of view.
 */
function readOffer(root: HTMLElement, box: HTMLElement): Offer | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  if (!inQuotable(root, selection.anchorNode) || !inQuotable(root, selection.focusNode)) return;
  const quote = selectionQuote(selection.toString());
  if (!quote) return;
  const lines = Array.from(selection.getRangeAt(0).getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return;
  const view = root.getBoundingClientRect();
  if (last.bottom < view.top || first.top > view.bottom) return;
  const frame = box.getBoundingClientRect();
  const above = first.top - frame.top - pillRoom;
  const top = above >= edge ? above : last.bottom - frame.top + edge;
  const left = Math.max(edge, Math.min(first.left - frame.left, frame.width - 96));
  return { quote, top, left };
}

/**
 * Select words in what an agent said and Reply puts them in the composer as a quote, caret
 * under it, so the reply says which part it answers. Shown once the selection settles (the
 * pointer or a key let go), it follows the selection while scrolling and goes when the
 * selection does. Only where this thread's composer is on screen to take the quote.
 */
export function ReplyToSelection(props: {
  threadId: string;
  viewport: RefObject<HTMLElement | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<Offer>();
  const read = useEffectEvent(() => {
    const root = props.viewport.current;
    if (!root || !box.current || !composerTakesText(props.threadId)) return undefined;
    return readOffer(root, box.current);
  });
  const settle = useEffectEvent(() => setOffer(read()));
  const follow = useEffectEvent(() => {
    if (offer) setOffer(read());
  });
  const dismiss = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape" && offer) setOffer(undefined);
  });
  useEffect(() => {
    const doc = box.current?.ownerDocument;
    const scroller = props.viewport.current;
    if (!doc || !scroller) return;
    const view = doc.defaultView;
    const moved = frameThrottle(() => follow());
    const onMoved = () => moved.request();
    const onSelection = () => follow();
    const onRelease = () => settle();
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Escape") settle();
    };
    const onKeyDown = (event: KeyboardEvent) => dismiss(event);
    doc.addEventListener("selectionchange", onSelection);
    doc.addEventListener("pointerup", onRelease);
    doc.addEventListener("keyup", onKeyUp);
    doc.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("scroll", onMoved, { passive: true });
    view?.addEventListener("resize", onMoved);
    return () => {
      moved.cancel();
      doc.removeEventListener("selectionchange", onSelection);
      doc.removeEventListener("pointerup", onRelease);
      doc.removeEventListener("keyup", onKeyUp);
      doc.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("scroll", onMoved);
      view?.removeEventListener("resize", onMoved);
    };
  }, [props.viewport]);
  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {offer && (
        <button
          type="button"
          // Pressing it must not drop the selection it quotes.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            // The composer takes the caret next, so the page's selection goes first.
            box.current?.ownerDocument.getSelection()?.removeAllRanges();
            insertTextInComposer(props.threadId, offer.quote);
            setOffer(undefined);
          }}
          className={cn(
            floatingControl,
            floatingHover,
            "pointer-events-auto absolute px-3 font-medium whitespace-nowrap text-foreground",
            "transition-[background-color,box-shadow] duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
          style={{ top: offer.top, left: offer.left }}
        >
          Reply
        </button>
      )}
    </div>
  );
}
