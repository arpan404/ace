import { spadeFoldLines } from "@ace/ui-core/spade-chat";
import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

/*
 * A long message folded in place (ADR 0212 amendment 2): the bubble shows its first twenty drawn
 * lines, wrapped ones counted, and Show more under them opens the rest where it is. Opening keeps
 * the bubble's top where it was and closing keeps Show less under the pointer, so the chat never
 * jumps; either one lets go of following the conversation's end, which would otherwise scroll
 * the grown bubble away. Open stays open while the bubble is on screen.
 */

/** What a fold asks of the scroller it sits in. */
export interface FoldScroll {
  /** The scroller, whose scroll keeps a fold's anchor where it was. */
  element: () => HTMLElement | null;
  /** Stop following the end: the person is reading here. */
  hold: () => void;
}

export const FoldScrollContext = createContext<FoldScroll | undefined>(undefined);

/** A line's height when the page doesn't say (`normal`, or no layout to ask). */
const fallbackLine = 24;

/** The words of a message that may fold, and Show more when they run past twenty lines. */
export function SpadeFold(props: { fold: boolean | undefined; children: ReactNode }) {
  if (!props.fold) return props.children;
  return <Folded>{props.children}</Folded>;
}

function Folded(props: { children: ReactNode }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLButtonElement>(null);
  const scroll = use(FoldScrollContext);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    const inner = words.current;
    if (!element || !inner) return;
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(element).lineHeight) || fallbackLine;
      setOver(inner.scrollHeight > line * spadeFoldLines + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The words, not the clamped box: they grow when markit finishes drawing them.
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const toggle = () => {
    // What stays put: the bubble's top as it opens, Show less as it closes.
    const anchor = open ? control.current : box.current;
    const top = anchor?.getBoundingClientRect().top;
    scroll?.hold();
    flushSync(() => setOpen(!open));
    const scroller = scroll?.element();
    if (!anchor || top === undefined || !scroller) return;
    const moved = anchor.getBoundingClientRect().top - top;
    if (moved) scroller.scrollTop += moved;
  };
  const folded = over && !open;
  return (
    <>
      <div
        ref={box}
        id={id}
        data-part="spade-fold"
        data-folded={folded ? "" : undefined}
        className="ace-spade-fold"
      >
        <div ref={words}>{props.children}</div>
      </div>
      {over && (
        <button
          ref={control}
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
          className="mt-1 text-ui text-muted-foreground hover:text-foreground focus-ring rounded-sm"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
