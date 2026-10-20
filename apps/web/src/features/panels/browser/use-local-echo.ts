import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ScreenFrame } from "../sources.ts";
import { LocalStore } from "../store.ts";
import { ScrollEcho, nextLatency } from "./local-echo.ts";

/** Each thread's input round trip in whole ms, for the ⋯ menu; absent until input was sent. */
export const inputLatency = new LocalStore<ReadonlyMap<string, number>>(new Map());

/** A tap or click shown where it landed, in the pane's CSS pixels. */
export interface Ripple {
  id: number;
  x: number;
  y: number;
}

/** A scroll the page never shows (at its end) stops moving the frame after this long (ms). */
const settleAfter = 600;

/**
 * The person's own input shown at once, before the page's picture catches up: a ripple where a
 * tap or click lands, the last picture moved by scrolls still in flight (`pictureStyle`), and
 * the round trip of every input for the ⋯ menu. A newer picture settles the scrolls the page
 * already had; pictures are watched only while there is such a scroll, so a steady stream of
 * them renders nothing.
 */
export function useLocalEcho(threadId: string, frame: ScreenFrame | undefined) {
  const [ripples, setRipples] = useState<readonly Ripple[]>([]);
  const [scrolls, setScrolls] = useState(() => new ScrollEcho());
  const [shownFrame, setShownFrame] = useState(frame);
  if (shownFrame !== frame) {
    setShownFrame(frame);
    setScrolls((echo) => echo.framed());
  }
  const settles = scrolls.framed() !== scrolls;
  useEffect(() => {
    if (!frame || !settles) return;
    return frame.subscribe(() => setScrolls((echo) => echo.framed()));
  }, [frame, settles]);
  const ids = useRef(0);
  const latency = useRef<number | undefined>(undefined);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  /** Send input and time its round trip. */
  const timed = useCallback(
    (send: () => void | Promise<void>): Promise<void> => {
      const started = performance.now();
      return Promise.resolve(send()).then(() => {
        const next = nextLatency(latency.current, performance.now() - started);
        latency.current = next;
        const shown = Math.round(next);
        if (inputLatency.get().get(threadId) !== shown)
          inputLatency.set((before) => new Map(before).set(threadId, shown));
      });
    },
    [threadId],
  );

  /** A scroll of the page by `x`, `y` page pixels, answered when `sent` settles. */
  const scroll = useCallback((x: number, y: number, sent: Promise<void>) => {
    const id = ids.current++;
    setScrolls((echo) => echo.sent(id, x, y));
    const drop = () => setScrolls((echo) => echo.dropped(id));
    sent.then(() => {
      setScrolls((echo) => echo.dispatched(id));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        drop();
      }, settleAfter);
      timers.current.add(timer);
    }, drop);
  }, []);

  /** A tap or click at this point of the pane. */
  const ripple = useCallback((x: number, y: number) => {
    const id = ids.current++;
    setRipples((before) => [...before.slice(-3), { id, x, y }]);
  }, []);

  /** A ripple finished its animation. */
  const settled = useCallback((id: number) => {
    setRipples((before) => before.filter((shown) => shown.id !== id));
  }, []);

  // A picture never slides more than a third of itself; percentages are of its own size.
  const width = frame?.width ?? 0;
  const height = frame?.height ?? 0;
  const offset = scrolls.offset({ x: width / 3, y: height / 3 });
  const pictureStyle: CSSProperties | undefined =
    (offset.x || offset.y) && width > 0 && height > 0
      ? { transform: `translate(${(offset.x / width) * 100}%, ${(offset.y / height) * 100}%)` }
      : undefined;

  return { ripples, ripple, settled, scroll, timed, pictureStyle };
}
