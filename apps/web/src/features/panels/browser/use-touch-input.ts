import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ForwardedInput } from "../sources.ts";
import {
  TouchGestures,
  longPressDelay,
  type PointerAt,
  type TouchEffect,
} from "./pointer-input.ts";

/** The device's main pointer is a finger: the page should lay out and behave as on a phone. */
export function useTouchScreen(): boolean {
  const [touch, setTouch] = useState(() => coarse()?.matches === true);
  useEffect(() => {
    const query = coarse();
    if (!query) return;
    const changed = () => setTouch(query.matches);
    changed();
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return touch;
}

function coarse(): MediaQueryList | undefined {
  return typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : undefined;
}

/**
 * Fingers on the live page go to it as touches: every finger down, each move coalesced to one
 * per display frame. A mouse or pen keeps the mouse handlers; their compatibility mouse events
 * for a touch are suppressed here, so a tap is not also a click. What the touches mean shows at
 * once through `echo`: a tap's ripple, a drag moving the frame.
 */
export function useTouchInput(options: {
  /** A pointer event's point in the page's pixels. */
  locate(event: PointerEvent<HTMLElement>): { x: number; y: number };
  /** Send input to the page, timed for the latency readout. */
  send(input: ForwardedInput): Promise<void>;
  echo: {
    ripple(x: number, y: number): void;
    scroll(x: number, y: number, sent: Promise<void>): void;
  };
  /**
   * ace's own page menu takes a long press (it opens on its own); the page's touch is
   * cancelled. Absent: the page gets the long press, as a phone's browser would.
   */
  onLongPress?: ((page: { x: number; y: number }) => void) | undefined;
}) {
  const gestures = useRef(new TouchGestures());
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const pending = useRef<{ input: ForwardedInput; sent: (done: Promise<void>) => void }[]>([]);
  const frame = useRef(0);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(hold.current);
    },
    [],
  );

  /** Send the latest coalesced move; every pan that waited on it learns when it landed. */
  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const moves = pending.current.splice(0);
    const last = moves.at(-1);
    if (!last) return;
    const done = latest.current.send(last.input);
    for (const move of moves) move.sent(done);
  };

  const run = (effects: TouchEffect[]) => {
    let pans: { x: number; y: number }[] = [];
    for (const effect of effects) {
      if (effect.type === "tap") latest.current.echo.ripple(effect.at.screen.x, effect.at.screen.y);
      else if (effect.type === "pan") pans.push(effect.page);
      else if (effect.type === "longPress") {
        const take = latest.current.onLongPress;
        if (!take) continue;
        clearTimeout(hold.current);
        take(effect.at.page);
        flush();
        run(gestures.current.cancel());
      } else if (effect.input.kind === "touch" && effect.input.event === "touchMove") {
        const waiting = pans;
        pans = [];
        pending.current.push({
          input: effect.input,
          // The page scrolls opposite to the finger: a drag down scrolls up.
          sent: (done) => {
            for (const pan of waiting) latest.current.echo.scroll(-pan.x, -pan.y, done);
          },
        });
        if (!frame.current) frame.current = requestAnimationFrame(flush);
      } else {
        flush();
        void latest.current.send(effect.input);
      }
    }
  };

  const at = (event: PointerEvent<HTMLElement>): PointerAt => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      screen: { x: event.clientX - box.left, y: event.clientY - box.top },
      page: latest.current.locate(event),
    };
  };

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch") return;
      // No compatibility mouse events: the touches are the whole of the input.
      event.preventDefault();
      if (gestures.current.active === 0) event.currentTarget.focus({ preventScroll: true });
      run(gestures.current.down(event.pointerId, at(event), event.timeStamp));
      clearTimeout(hold.current);
      hold.current = setTimeout(
        () => run(gestures.current.elapsed(performance.now())),
        longPressDelay,
      );
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch") return;
      run(gestures.current.move(event.pointerId, at(event)));
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch") return;
      run(gestures.current.up(event.pointerId, at(event), event.timeStamp));
      if (gestures.current.active === 0) clearTimeout(hold.current);
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch") return;
      clearTimeout(hold.current);
      flush();
      run(gestures.current.cancel());
    },
  };
}
