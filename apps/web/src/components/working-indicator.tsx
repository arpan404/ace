import { formatElapsed, timedWords } from "@ace/ui-core";
import { useContext, useLayoutEffect, useRef, type CSSProperties } from "react";
import { cn } from "@/lib/cn.ts";
import { TimeContext } from "@/lib/time.ts";

/*
 * Something is working: a tiny 3x3 pixel grid whose lit cell walks round its edge, words, and how
 * long it has run in tabular figures ("Working for 3m 6s"). The walk is a CSS animation on
 * opacity (`.fx-walk`, styles/motion.css), so it runs on the compositor with no React render and
 * no timer; under reduced motion, or while the work waits, it holds one still pattern. Any row
 * that shows something working (a sidebar row, say) can use `WorkingIndicator` for the same look.
 */

/** The order the lit cell walks: round the edge, clockwise. */
const walk = [0, 1, 2, 5, 8, 7, 6, 3] as const;
const corners = new Set([0, 2, 6, 8]);

/** The pixel-grid glyph. `moving: false` holds the still pattern (waiting, stale). */
function WorkingGlyph(props: { moving?: boolean; className?: string }) {
  const moving = props.moving ?? true;
  return (
    <span
      aria-hidden
      data-live={moving ? "" : undefined}
      data-still={moving ? undefined : ""}
      className={cn("fx-walk grid size-2.5 shrink-0 grid-cols-3 gap-px", props.className)}
    >
      {Array.from({ length: 9 }, (_, index) => {
        const step = walk.indexOf(index as (typeof walk)[number]);
        return (
          <span
            key={index}
            data-step={step === -1 ? undefined : ""}
            data-corner={corners.has(index) ? "" : undefined}
            data-centre={index === 4 ? "" : undefined}
            style={step === -1 ? undefined : ({ "--step": step } as CSSProperties)}
            className="bg-current"
          />
        );
      })}
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
  return <span ref={element} className={cn("tabular-nums", props.className)} />;
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
          <span className="tabular-nums">{formatElapsed(props.held)}</span>
        ) : (
          props.from !== undefined && <ElapsedTime from={props.from} />
        )}
      </span>
    </span>
  );
}
