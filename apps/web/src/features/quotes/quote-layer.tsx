import { passageText, quoteContextChars, type MessageQuote } from "@ace/ui-core";
import { QuotesIcon } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/cn.ts";
import { frameThrottle } from "@/lib/frame-throttle.ts";
import { floatingControl } from "@/components/floating-control.ts";
import { useQuotePort } from "./store.ts";
import { contextAround, textOffset } from "./text-offsets.ts";

/** Agent prose the person can reply to part of. */
const quotable = "[data-quotable]";
/** The Reply pill's height and the gap it keeps from the selected line. */
const pillRoom = 36;
const edge = 4;

/**
 * Hovering fills the pill with the next surface, as the transcript's other floating controls
 * do, and lights its icon; its edge stays as it is, never a bright ring.
 */
const hover = "hover:bg-surface-1 [&:hover_svg]:text-foreground";

/** A selection in one agent message, waiting for Reply. */
interface Offer {
  quote: Omit<MessageQuote, "id">;
  top: number;
  left: number;
}

function messageOf(root: HTMLElement, node: Node | null): HTMLElement | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const hit = element?.closest<HTMLElement>(quotable);
  return hit && root.contains(hit) ? hit : undefined;
}

/**
 * The selection's range inside one agent message. An end that spills past the message's words
 * (a triple click runs to the start of what follows) is pulled back to them; a selection
 * reaching into another message, or holding none, is no passage.
 */
function rangeIn(root: HTMLElement, selection: Selection) {
  const range = selection.getRangeAt(0);
  const starts = messageOf(root, range.startContainer);
  const ends = messageOf(root, range.endContainer);
  const message = starts ?? ends;
  if (!message || (starts && ends && starts !== ends)) return undefined;
  if (starts === ends) return { message, range, text: selection.toString() };
  const words = message.ownerDocument.createRange();
  words.selectNodeContents(message);
  const kept = range.cloneRange();
  if (!starts) kept.setStart(words.startContainer, words.startOffset);
  if (!ends) kept.setEnd(words.endContainer, words.endOffset);
  return { message, range: kept, text: kept.toString() };
}

/**
 * The person's selection inside one agent message, as a quote with the words around it, and
 * where Reply goes in `box`: over its first line, or under its last when there is no room above.
 * Nothing when the selection leaves the message or is scrolled out of view.
 */
function readOffer(root: HTMLElement, box: HTMLElement): Offer | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const picked = rangeIn(root, selection);
  if (!picked) return;
  const { message, range } = picked;
  const text = passageText(picked.text);
  if (!text) return;
  const lines = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return;
  const view = root.getBoundingClientRect();
  if (last.bottom < view.top || first.top > view.bottom) return;
  const start = textOffset(message, range.startContainer, range.startOffset);
  const end = textOffset(message, range.endContainer, range.endOffset);
  const frame = box.getBoundingClientRect();
  const above = first.top - frame.top - pillRoom;
  return {
    quote: { text, ...contextAround(message, start, end, quoteContextChars) },
    top: above >= edge ? above : last.bottom - frame.top + edge,
    left: Math.max(edge, Math.min(first.left - frame.left, frame.width - 96)),
  };
}

/**
 * Select words in what an agent said and Reply puts them above the composer as a quote, caret in
 * the message box, so the reply says which part it answers. Shown once the selection settles
 * (the pointer let go, a double or triple click, Select All or a key), it follows the selection
 * while scrolling and goes when the selection does. Only where this thread's composer is on screen to take the quote.
 */
export function QuoteLayer(props: { threadId: string; viewport: RefObject<HTMLElement | null> }) {
  const port = useQuotePort(props.threadId);
  const box = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<Offer>();
  const read = useEffectEvent(() => {
    const root = props.viewport.current;
    if (!root || !box.current || !port || port.full) return undefined;
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
    // While the pointer is down a drag is still choosing; once it is up, any change to the
    // selection (a double or triple click, Select All, a key) is a settled choice.
    let pressed = false;
    const changed = frameThrottle(() => (pressed ? follow() : settle()));
    const onSelection = () => changed.request();
    const onPress = () => {
      pressed = true;
    };
    const onRelease = () => {
      pressed = false;
      settle();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Escape") settle();
    };
    const onKeyDown = (event: KeyboardEvent) => dismiss(event);
    doc.addEventListener("selectionchange", onSelection);
    doc.addEventListener("pointerdown", onPress);
    doc.addEventListener("pointerup", onRelease);
    doc.addEventListener("pointercancel", onRelease);
    doc.addEventListener("keyup", onKeyUp);
    doc.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("scroll", onMoved, { passive: true });
    view?.addEventListener("resize", onMoved);
    return () => {
      moved.cancel();
      changed.cancel();
      doc.removeEventListener("selectionchange", onSelection);
      doc.removeEventListener("pointerdown", onPress);
      doc.removeEventListener("pointerup", onRelease);
      doc.removeEventListener("pointercancel", onRelease);
      doc.removeEventListener("keyup", onKeyUp);
      doc.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("scroll", onMoved);
      view?.removeEventListener("resize", onMoved);
    };
  }, [props.viewport]);
  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {offer && port && (
        <button
          type="button"
          // Pressing it must not drop the selection it quotes.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            // The composer takes the caret next, so the page's selection goes first.
            box.current?.ownerDocument.getSelection()?.removeAllRanges();
            setOffer(undefined);
            port.add({ ...offer.quote, id: crypto.randomUUID() });
            port.focus();
          }}
          className={cn(
            // The floating glass every pill uses: it follows Translucency, Solid included.
            floatingControl,
            hover,
            "pointer-events-auto absolute pr-3 pl-2.5 font-medium whitespace-nowrap text-foreground",
            "transition-[background-color,box-shadow] duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
          style={{ top: offer.top, left: offer.left }}
        >
          <QuotesIcon aria-hidden size={15} weight="fill" className="text-muted-foreground" />
          Reply
        </button>
      )}
    </div>
  );
}
