import { formatElapsed, timedWords } from "@ace/ui-core";
import { useContext, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn.ts";
import { useReducedMotion } from "@/lib/motion.ts";
import { TimeContext } from "@/lib/time.ts";

/*
 * Something is working: a tiny 3x3 pixel grid whose lit cells walk round it, words, and how long
 * it has run in monospace ("Working for 3m 6s"). The grid steps on the page's shared one-second clock
 * and writes through refs, so it costs no React render and no perpetual CSS animation; under
 * reduced motion it holds one still pattern. Any row that shows something working (a sidebar
 * row, say) can use `WorkingIndicator` for the same look.
 */

/** The order the lit cell walks: round the edge, clockwise. */
const walk = [0, 1, 2, 5, 8, 7, 6, 3] as const;
const still = new Set([0, 2, 4, 6, 8]);

/** The pixel-grid glyph. `moving: false` holds the still pattern (waiting, stale). */
function WorkingGlyph(props: { moving?: boolean; className?: string }) {
  const grid = useRef<HTMLSpanElement>(null);
  const { seconds } = useContext(TimeContext);
  const reduced = useReducedMotion();
  const moving = (props.moving ?? true) && !reduced;
  useLayoutEffect(() => {
    const cells = [...(grid.current?.children ?? [])].filter(
      (cell): cell is HTMLElement => cell instanceof HTMLElement,
    );
    const paint = (lit: (index: number) => number) =>
      cells.forEach((cell, index) => {
        cell.style.opacity = String(lit(index));
      });
    if (!moving) {
      paint((index) => (still.has(index) ? 0.9 : 0.25));
      return;
    }
    const step = () => {
      const at = Math.floor(seconds.read() / 1000) % walk.length;
      const head = walk[at];
      const tail = walk[(at + walk.length - 1) % walk.length];
      paint((index) => (index === head ? 1 : index === tail ? 0.55 : index === 4 ? 0.4 : 0.2));
    };
    step();
    return seconds.subscribe(step);
  }, [seconds, moving]);
  return (
    <span
      ref={grid}
      aria-hidden
      className={cn("grid size-2.5 shrink-0 grid-cols-3 gap-px", props.className)}
    >
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} className="bg-current" />
      ))}
    </span>
  );
}

/** "1m 14s" since `from`, written straight into the element on the shared clock. */
export function ElapsedTime(props: { from: number; className?: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const { seconds } = useContext(TimeContext);
  const { from } = props;
  useLayoutEffect(() => {
    const write = () => {
      if (element.current)
        element.current.textContent = formatElapsed(Math.max(0, seconds.read() - from));
    };
    write();
    return seconds.subscribe(write);
  }, [seconds, from]);
  return <span ref={element} className={cn("font-mono text-xs tabular-nums", props.className)} />;
}

/**
 * `[grid] Working for 3m 6s`: the glyph, the words, and the time it has run. Without a time it
 * reads the bare label ("Working"); with one, "for" joins them (`timedWords`).
 */
export function WorkingIndicator(props: {
  /** What is happening; "Working" by default. */
  label?: string;
  /** When the work began; no time without it. */
  from?: number | undefined;
  /** A time it reached and holds (a wait): shown still, the glyph still. */
  held?: number | undefined;
  /** Whether the glyph moves; still while the work waits (and whenever a time is held). */
  moving?: boolean | undefined;
  className?: string;
}) {
  const moving = (props.moving ?? true) && props.held === undefined;
  const label = props.label ?? "Working";
  const timed = props.held !== undefined || props.from !== undefined;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", props.className)}>
      <WorkingGlyph moving={moving} />
      {/* One run of text, one space: "Working for 3m 6s". */}
      <span className="shrink-0">
        {timed ? `${timedWords(label)} ` : label}
        {props.held !== undefined ? (
          <span className="font-mono text-xs tabular-nums">{formatElapsed(props.held)}</span>
        ) : (
          props.from !== undefined && <ElapsedTime from={props.from} />
        )}
      </span>
    </span>
  );
}
