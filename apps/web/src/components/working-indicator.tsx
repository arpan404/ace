import { formatElapsed, timedWords } from "@ace/ui-core";
import { useContext, useLayoutEffect, useRef } from "react";
import { StatusGlyph } from "./status-glyph.tsx";
import { cn } from "@/lib/cn.ts";
import { TimeContext } from "@/lib/time.ts";

/*
 * Something is working: the Aperture working glyph (its ring's halves swinging, status-glyph.tsx),
 * words, and how long it has run in tabular figures ("Working for 3m 6s"). The glyph moves by a
 * CSS animation on the compositor, with no React render and no timer; while the work waits it
 * holds its rest pose. Any row that shows something working can use `WorkingIndicator` for the
 * same look.
 */

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
      <StatusGlyph state="working" still={!moving} />
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
